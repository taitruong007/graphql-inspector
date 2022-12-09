import { createCommand, GlobalArgs, parseGlobalArgs, CommandFactory } from '@graphql-inspector/commands';
import { Logger, bolderize, chalk } from '@graphql-inspector/logger';
import { validate as validateDocuments, InvalidDocument } from '@graphql-inspector/core';
import { Source as DocumentSource } from '@graphql-tools/utils';
import { relative } from 'path';
import { writeFileSync } from 'fs';
import { Source, print, GraphQLSchema, GraphQLError } from 'graphql';

export { CommandFactory };

export function handler({
  schema,
  documents,
  strictFragments,
  maxDepth,
  maxDirectiveCount,
  maxAliasCount,
  maxTokenCount,
  apollo,
  keepClientFields,
  failOnDeprecated,
  filter,
  onlyErrors,
  relativePaths,
  output,
  silent,
  maxComplexityScore,
  complexityScalarCost,
  complexityObjectCost,
  complexityDepthCostFactor,
}: {
  schema: GraphQLSchema;
  documents: DocumentSource[];
  failOnDeprecated: boolean;
  strictFragments: boolean;
  apollo: boolean;
  keepClientFields: boolean;
  maxDepth?: number;
  maxDirectiveCount?: number;
  maxAliasCount?: number;
  maxTokenCount?: number;
  filter?: string[];
  onlyErrors?: boolean;
  relativePaths?: boolean;
  output?: string;
  silent?: boolean;
  maxComplexityScore?: number;
  complexityScalarCost?: number;
  complexityObjectCost?: number;
  complexityDepthCostFactor?: number;
}) {
  let invalidDocuments = validateDocuments(
    schema,
    documents.map(doc => new Source(print(doc.document!), doc.location)),
    {
      strictFragments,
      maxDepth,
      maxAliasCount,
      maxDirectiveCount,
      maxTokenCount,
      apollo,
      keepClientFields,
      maxComplexityScore,
      complexityScalarCost,
      complexityObjectCost,
      complexityDepthCostFactor,
    }
  );

  if (!invalidDocuments.length) {
    Logger.success('All documents are valid');
  } else {
    if (failOnDeprecated) {
      invalidDocuments = moveDeprecatedToErrors(invalidDocuments);
    }

    if (relativePaths) {
      invalidDocuments = useRelativePaths(invalidDocuments);
    }

    const errorsCount = countErrors(invalidDocuments);
    const deprecated = countDeprecated(invalidDocuments);
    const shouldFailProcess = errorsCount > 0;

    if (errorsCount) {
      if (!silent) {
        Logger.log(`\nDetected ${errorsCount} invalid document${errorsCount > 1 ? 's' : ''}:\n`);
      }

      printInvalidDocuments(useFilter(invalidDocuments, filter), 'errors', true, silent);
    } else {
      Logger.success('All documents are valid');
    }

    if (deprecated && !onlyErrors) {
      if (!silent) {
        Logger.info(`\nDetected ${deprecated} document${deprecated > 1 ? 's' : ''} with deprecated fields:\n`);
      }

      printInvalidDocuments(useFilter(invalidDocuments, filter), 'deprecated', false, silent);
    }

    if (output) {
      writeFileSync(
        output,
        JSON.stringify(
          {
            status: !shouldFailProcess,
            documents: useFilter(invalidDocuments, filter),
          },
          null,
          2
        ),
        {
          encoding: 'utf-8',
        }
      );
    }

    if (shouldFailProcess) {
      process.exit(1);
    }
  }
}

function moveDeprecatedToErrors(docs: InvalidDocument[]) {
  return docs.map(doc => ({
    source: doc.source,
    errors: [...(doc.errors ?? []), ...(doc.deprecated ?? [])],
    deprecated: [],
  }));
}

function useRelativePaths(docs: InvalidDocument[]) {
  return docs.map(doc => {
    doc.source.name = relative(process.cwd(), doc.source.name);
    return doc;
  });
}

function useFilter(docs: InvalidDocument[], patterns?: string[]) {
  if (!patterns || !patterns.length) {
    return docs;
  }

  return docs.filter(doc => patterns.some(filepath => doc.source.name.includes(filepath)));
}

export default createCommand<
  {},
  {
    schema: string;
    documents: string;
    deprecated: boolean;
    noStrictFragments: boolean;
    apollo: boolean;
    keepClientFields: boolean;
    maxDepth?: number;
    maxAliasCount?: number;
    maxDirectiveCount?: number;
    maxTokenCount?: number;
    filter?: string[];
    onlyErrors?: boolean;
    relativePaths?: boolean;
    output?: string;
    silent?: boolean;
    ignore?: string[];
    maxComplexityScore?: number;
    complexityScalarCost?: number;
    complexityObjectCost?: number;
    complexityDepthCostFactor?: number;
  } & GlobalArgs
>(api => {
  const { loaders } = api;

  return {
    command: 'validate <documents> <schema>',
    describe: 'Validate Fragments and Operations',
    builder(yargs) {
      return yargs
        .positional('schema', {
          describe: 'Point to a schema',
          type: 'string',
          demandOption: true,
        })
        .positional('documents', {
          describe: 'Point to documents',
          type: 'string',
          demandOption: true,
        })
        .options({
          deprecated: {
            alias: 'd',
            describe: 'Fail on deprecated usage',
            type: 'boolean',
            default: false,
          },
          noStrictFragments: {
            describe: 'Do not fail on duplicated fragment names',
            type: 'boolean',
            default: false,
          },
          maxDepth: {
            describe: 'Fail on deep operations',
            type: 'number',
          },
          maxAliasCount: {
            describe: 'Fail on operations with too many aliases',
            type: 'number',
          },
          maxDirectiveCount: {
            describe: 'Fail on operations with too many directives',
            type: 'number',
          },
          maxTokenCount: {
            describe: 'Fail on operations with too many tokens',
            type: 'number',
          },
          apollo: {
            describe: 'Support Apollo directives',
            type: 'boolean',
            default: false,
          },
          keepClientFields: {
            describe: 'Keeps the fields with @client, but removes @client directive from them',
            type: 'boolean',
            default: false,
          },
          filter: {
            describe: 'Show results only from a list of files (or file)',
            array: true,
            type: 'string',
          },
          ignore: {
            describe: 'Ignore and do not load these files (supports glob)',
            array: true,
            type: 'string',
          },
          onlyErrors: {
            describe: 'Show only errors',
            type: 'boolean',
            default: false,
          },
          relativePaths: {
            describe: 'Show relative paths',
            type: 'boolean',
            default: false,
          },
          silent: {
            describe: 'Do not print results',
            type: 'boolean',
            default: false,
          },
          output: {
            describe: 'Output JSON file',
            type: 'string',
          },
          maxComplexityScore: {
            describe: 'Fail on complexity score operations',
            type: 'number',
            default: 1500,
          },
          complexityScalarCost: {
            describe: 'Scarlar cost config to use with maxComplexityScore',
            type: 'number',
            default: 1,
          },
          complexityObjectCost: {
            describe: 'Object cost config to use with maxComplexityScore',
            type: 'number',
            default: 2,
          },
          complexityDepthCostFactor: {
            describe: 'depth cost factor config to use with maxComplexityScore',
            type: 'number',
            default: 1.5,
          },
        });
    },
    async handler(args) {
      const { headers, token } = parseGlobalArgs(args);
      const apollo = args.apollo || false;
      const aws = args.aws || false;
      const apolloFederation = args.federation || false;
      const method = args.method?.toUpperCase() || 'POST';
      const maxDepth = args.maxDepth != null ? args.maxDepth : undefined;
      const maxAliasCount = args.maxAliasCount != null ? args.maxAliasCount : undefined;
      const maxDirectiveCount = args.maxDirectiveCount != null ? args.maxDirectiveCount : undefined;
      const maxTokenCount = args.maxTokenCount != null ? args.maxTokenCount : undefined;
      const strictFragments = !args.noStrictFragments;
      const keepClientFields = args.keepClientFields || false;
      const failOnDeprecated = args.deprecated;
      const output = args.output;
      const silent = args.silent || false;
      const relativePaths = args.relativePaths || false;
      const onlyErrors = args.onlyErrors || false;
      const ignore = args.ignore || [];
      const maxComplexityScore = args.maxComplexityScore;
      const complexityScalarCost = args.complexityScalarCost;
      const complexityObjectCost = args.complexityObjectCost;
      const complexityDepthCostFactor = args.complexityDepthCostFactor;

      const schema = await loaders.loadSchema(
        args.schema,
        {
          headers,
          token,
          method,
        },
        apolloFederation,
        aws
      );
      const documents = await loaders.loadDocuments(args.documents, {
        ignore,
      });

      return handler({
        schema,
        documents,
        apollo,
        maxDepth,
        maxAliasCount,
        maxDirectiveCount,
        maxTokenCount,
        strictFragments,
        keepClientFields,
        failOnDeprecated,
        filter: args.filter,
        silent,
        output,
        relativePaths,
        onlyErrors,
        maxComplexityScore,
        complexityScalarCost,
        complexityObjectCost,
        complexityDepthCostFactor,
      });
    },
  };
});

function countErrors(invalidDocuments: InvalidDocument[]): number {
  if (invalidDocuments.length) {
    return invalidDocuments.filter(doc => doc.errors && doc.errors.length).length;
  }

  return 0;
}

function countDeprecated(invalidDocuments: InvalidDocument[]): number {
  if (invalidDocuments.length) {
    return invalidDocuments.filter(doc => doc.deprecated && doc.deprecated.length).length;
  }

  return 0;
}

function printInvalidDocuments(
  invalidDocuments: InvalidDocument[],
  listKey: 'errors' | 'deprecated',
  isError = false,
  silent = false
): void {
  if (silent) {
    return;
  }

  invalidDocuments.forEach(doc => {
    if (doc.errors.length) {
      renderErrors(doc.source.name, doc[listKey], isError).forEach(line => {
        Logger.log(line);
      });
    }
  });
}

function renderErrors(sourceName: string, errors: GraphQLError[], isError = false): string[] {
  const errorsAsString = errors.map(e => ` - ${bolderize(e.message)}`).join('\n');

  return [
    isError ? chalk.redBright('error') : chalk.yellowBright('warn'),
    `in ${sourceName}:\n\n`,
    errorsAsString,
    '\n\n',
  ];
}
