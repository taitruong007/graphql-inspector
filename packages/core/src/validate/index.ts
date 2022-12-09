import {
  GraphQLSchema,
  GraphQLError,
  Source,
  print,
  validate as validateDocument,
  FragmentDefinitionNode,
  DocumentNode,
  Kind,
} from 'graphql';
import { DepGraph } from 'dependency-graph';

import { readDocument } from '../ast/document';
import { findDeprecatedUsages } from '../utils/graphql';
import { validateQueryDepth } from './query-depth';
import { validateComplexity } from './complexity';
import { transformSchemaWithApollo, transformDocumentWithApollo } from '../utils/apollo';
import { validateAliasCount } from './alias-count';
import { validateDirectiveCount } from './directive-count';
import { validateTokenCount } from './token-count';

export interface InvalidDocument {
  source: Source;
  errors: GraphQLError[];
  deprecated: GraphQLError[];
}

export interface ValidateOptions {
  /**
   * Fails on duplicated fragment names
   * @default true
   */
  strictFragments?: boolean;
  /**
   * Fails on deprecated usage
   * @default true
   */
  strictDeprecated?: boolean;
  /**
   * Works only with combination of `apollo`
   * @default false
   */
  keepClientFields?: boolean;
  /**
   * Supports Apollo directives (`@client` and `@connection`)
   * @default false
   */
  apollo?: boolean;
  /**
   * Fails when operation depth exceeds maximum depth (including the referenced fragments).
   * @default Infinity
   */
  maxDepth?: number;
  /**
   * Fails when alias count exceeds maximum count (including the referenced fragments).
   * @default Infinity
   */
  maxAliasCount?: number;
  /**
   * Fails when the directive count exceeds maximum count for a single operation (including the referenced fragments).
   * @default Infinity
   */
  maxDirectiveCount?: number;
  /**
   * Fails when the token count exceeds maximum count for a single operation (including the referenced fragments).
   * @default Infinity
   */
  maxTokenCount?: number;
  /**
   * Fails when complexity score exceeds maximum complexity score (including the referenced fragments).
   * @default Infinity
   */
  maxComplexityScore?: number;
  /**
   * Complexity Scalar cost config which using with maxComplexityScore.
   * @default Infinity
   */
  complexityScalarCost?: number;
  /**
   * Complexity object cost config which using with maxComplexityScore.
   * @default Infinity
   */
  complexityObjectCost?: number;
  /**
   * Complexity depth cost factor config which using with maxComplexityScore.
   * @default Infinity
   */
  complexityDepthCostFactor?: number;
}

export function validate(schema: GraphQLSchema, sources: Source[], options?: ValidateOptions): InvalidDocument[] {
  const config: ValidateOptions = {
    strictDeprecated: true,
    strictFragments: true,
    keepClientFields: false,
    apollo: false,
    ...options,
  };
  const invalidDocuments: InvalidDocument[] = [];
  // read documents
  const documents = sources.map(readDocument);
  // keep all named fragments
  const fragments: Array<{ node: FragmentDefinitionNode; source: string }> = [];
  const fragmentNames: string[] = [];
  const graph = new DepGraph<FragmentDefinitionNode>({ circular: true });

  documents.forEach(doc => {
    doc.fragments.forEach(fragment => {
      fragmentNames.push(fragment.node.name.value);
      fragments.push(fragment);
      graph.addNode(fragment.node.name.value, fragment.node);
    });
  });

  fragments.forEach(fragment => {
    const depends = extractFragments(print(fragment.node));

    if (depends) {
      depends.forEach(name => {
        graph.addDependency(fragment.node.name.value, name);
      });
    }
  });

  documents
    // since we include fragments, validate only operations
    .filter(doc => doc.hasOperations)
    .forEach(doc => {
      const docWithOperations: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: doc.operations.map(d => d.node),
      };
      const extractedFragments = (extractFragments(print(docWithOperations)) || [])
        // resolve all nested fragments
        .map(fragmentName => resolveFragment(graph.getNodeData(fragmentName), graph))
        // flatten arrays
        .reduce((list, current) => list.concat(current), [])
        // remove duplicates
        .filter((def, i, all) => all.findIndex(item => item.name.value === def.name.value) === i);
      const merged: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: [...docWithOperations.definitions, ...extractedFragments],
      };

      let transformedSchema = config.apollo ? transformSchemaWithApollo(schema) : schema;

      const transformedDoc = config.apollo
        ? transformDocumentWithApollo(merged, {
            keepClientFields: config.keepClientFields!,
          })
        : merged;

      const errors = (validateDocument(transformedSchema, transformedDoc) as GraphQLError[]) || [];

      if (config.maxDepth) {
        const depthError = validateQueryDepth({
          source: doc.source,
          doc: transformedDoc,
          maxDepth: config.maxDepth,
          fragmentGraph: graph,
        });

        if (depthError) {
          errors.push(depthError);
        }
      }

      if (config.maxComplexityScore) {
        const complexityScoreError = validateComplexity({
          source: doc.source,
          doc: transformedDoc,
          maxComplexityScore: config.maxComplexityScore,
          config: {
            scalarCost: config.complexityScalarCost ?? 1,
            objectCost: config.complexityObjectCost ?? 2,
            depthCostFactor: config.complexityDepthCostFactor ?? 1.5,
          },
          fragmentGraph: graph,
        });

        if (complexityScoreError) {
          errors.push(complexityScoreError);
        }
      }

      if (config.maxAliasCount) {
        const aliasError = validateAliasCount({
          source: doc.source,
          doc: transformedDoc,
          maxAliasCount: config.maxAliasCount,
          fragmentGraph: graph,
        });

        if (aliasError) {
          errors.push(aliasError);
        }
      }

      if (config.maxDirectiveCount) {
        const directiveError = validateDirectiveCount({
          source: doc.source,
          doc: transformedDoc,
          maxDirectiveCount: config.maxDirectiveCount,
          fragmentGraph: graph,
        });

        if (directiveError) {
          errors.push(directiveError);
        }
      }

      if (config.maxTokenCount) {
        const tokenCountError = validateTokenCount({
          source: doc.source,
          document: transformedDoc,
          maxTokenCount: config.maxTokenCount,
          getReferencedFragmentSource: fragmentName => print(graph.getNodeData(fragmentName)),
        });

        if (tokenCountError) {
          errors.push(tokenCountError);
        }
      }

      const deprecated = config.strictDeprecated ? findDeprecatedUsages(transformedSchema, transformedDoc) : [];
      const duplicatedFragments = config.strictFragments ? findDuplicatedFragments(fragmentNames) : [];

      if (sumLengths(errors, duplicatedFragments, deprecated) > 0) {
        invalidDocuments.push({
          source: doc.source,
          errors: [...errors, ...duplicatedFragments],
          deprecated,
        });
      }
    });

  return invalidDocuments;
}

function findDuplicatedFragments(fragmentNames: string[]) {
  return fragmentNames
    .filter((name, i, all) => all.indexOf(name) !== i)
    .map(name => new GraphQLError(`Name of '${name}' fragment is not unique`));
}

//
// PostInfo -> AuthorInfo
// AuthorInfo -> None
//
function resolveFragment(
  fragment: FragmentDefinitionNode,
  graph: DepGraph<FragmentDefinitionNode>
): FragmentDefinitionNode[] {
  return graph
    .dependenciesOf(fragment.name.value)
    .reduce((list, current) => [...list, ...resolveFragment(graph.getNodeData(current), graph)], [fragment]);
}

function extractFragments(document: string): string[] | undefined {
  return (document.match(/[\.]{3}[a-z0-9\_]+\b/gi) || []).map(name => name.replace('...', ''));
}

function sumLengths(...arrays: any[][]): number {
  return arrays.reduce((sum, { length }) => sum + length, 0);
}
