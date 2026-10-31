import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SignalSourceConfig } from '@cat-cafe/shared';
import { SignalSourceConfigSchema } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { resolveSignalPaths } from '../../domains/signals/config/signal-paths.js';
import { saveSignalSources } from '../../domains/signals/config/sources-loader.js';
import { ArticleStoreService, type SignalRedisIndexClient } from '../../domains/signals/services/article-store.js';
import { parseLegacyArticles } from './legacy-article-parser.js';
import { slugify } from './shared.js';
import { createFallbackSource, mergeSources, parseLegacySources, readTargetSourceConfig } from './source-migration.js';

const USAGE = [
  'Usage: pnpm --filter @cat-cafe/api run migrate-signals -- [options]',
  '',
  'Options:',
  '  --from <path>       legacy Signal Hunter root (required)',
  '  --to <path>         target signals root (default: SIGNALS_ROOT_DIR or ~/.cat-cafe/signals)',
  '  --dry-run           parse + plan only, do not write files',
  '  --redis-url <url>   optional Redis URL for index write-through',
  '  --help              print this help',
];

export interface MigrateSignalsCliArgs {
  readonly fromDir?: string | undefined;
  readonly toDir?: string | undefined;
  readonly dryRun: boolean;
  readonly redisUrl?: string | undefined;
  readonly help: boolean;
}

export interface MigrateSignalsCliIo {
  log(message: string): void;
  error(message: string): void;
}

export interface MigrateSignalsSummary {
  readonly dryRun: boolean;
  readonly legacyRoot: string;
  readonly targetRoot: string;
  readonly mergedSources: number;
  readonly fallbackSources: number;
  readonly migratedArticles: number;
  readonly skippedArticles: number;
}

function toUsage(): string {
  return USAGE.join('\n');
}

export function parseMigrateSignalsArgs(argv: readonly string[]): MigrateSignalsCliArgs {
  let fromDir: string | undefined;
  let toDir: string | undefined;
  let dryRun = false;
  let redisUrl: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') continue;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--from' || arg === '--to' || arg === '--redis-url') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--from') fromDir = value;
      if (arg === '--to') toDir = value;
      if (arg === '--redis-url') redisUrl = value;
      i += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    ...(fromDir ? { fromDir } : {}),
    ...(toDir ? { toDir } : {}),
    dryRun,
    ...(redisUrl ? { redisUrl } : {}),
    help,
  };
}

export function formatMigrateSignalsSummary(summary: MigrateSignalsSummary): string {
  return [
    '[signals] migration completed',
    `dryRun=${summary.dryRun}`,
    `legacyRoot=${summary.legacyRoot}`,
    `targetRoot=${summary.targetRoot}`,
    `mergedSources=${summary.mergedSources}`,
    `fallbackSources=${summary.fallbackSources}`,
    `migratedArticles=${summary.migratedArticles}`,
    `skippedArticles=${summary.skippedArticles}`,
  ].join(' ');
}

function buildAliasToSourceId(config: SignalSourceConfig): Map<string, string> {
  const aliasToId = new Map<string, string>();
  for (const source of config.sources) {
    aliasToId.set(slugify(source.id), source.id);
    aliasToId.set(slugify(source.name), source.id);
  }
  return aliasToId;
}

function tryResolveSourceId(
  aliasToId: ReadonlyMap<string, string>,
  sourceLabel: string | undefined,
  folderName: string,
): string | undefined {
  const bySourceLabel = aliasToId.get(slugify(sourceLabel ?? ''));
  if (bySourceLabel) return bySourceLabel;

  const byFolder = aliasToId.get(slugify(folderName));
  if (byFolder) return byFolder;

  const byMerged = aliasToId.get(slugify(sourceLabel ?? folderName));
  if (byMerged) return byMerged;

  return undefined;
}

async function assertLegacyRootDir(legacyRoot: string): Promise<void> {
  let stats;
  try {
    stats = await stat(legacyRoot);
  } catch {
    throw new Error(`legacy root not found: ${legacyRoot}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`legacy root is not a directory: ${legacyRoot}`);
  }
}

export async function runMigrateSignalsCli(
  argv: readonly string[] = process.argv.slice(2),
  io: MigrateSignalsCliIo = console,
): Promise<number> {
  let args: MigrateSignalsCliArgs;

  try {
    args = parseMigrateSignalsArgs(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error('');
    io.error(toUsage());
    return 1;
  }

  if (args.help) {
    io.log(toUsage());
    return 0;
  }

  if (!args.fromDir) {
    io.error('--from is required');
    io.error('');
    io.error(toUsage());
    return 1;
  }

  const legacyRoot = resolve(args.fromDir);
  const paths = resolveSignalPaths(args.toDir);
  const legacySourcesFile = join(legacyRoot, 'config', 'sources.yaml');
  const legacyLibraryDir = join(legacyRoot, 'library');

  try {
    await assertLegacyRootDir(legacyRoot);
    const baseConfig = await readTargetSourceConfig(paths.sourcesFile);
    const legacySourceMigration = await parseLegacySources(legacySourcesFile);
    let parserSkippedArticles = 0;
    const legacyArticles = await parseLegacyArticles(legacyLibraryDir, {
      onSkipMalformed: ({ filePath, reason }) => {
        parserSkippedArticles += 1;
        io.log(`[signals] skipped malformed legacy article file=${filePath} reason=${reason}`);
      },
    });

    let { config: mergedConfig, idRemap } = mergeSources(baseConfig, legacySourceMigration.sources);
    const aliasToId = buildAliasToSourceId(mergedConfig);

    for (const [alias, sourceId] of legacySourceMigration.aliasToId.entries()) {
      aliasToId.set(alias, idRemap.get(sourceId) ?? sourceId);
    }

    let fallbackSources = 0;
    let skippedArticles = parserSkippedArticles;
    let migratedArticles = 0;

    const redis = args.redisUrl ? createRedisClient({ url: args.redisUrl }) : undefined;
    const store = args.dryRun
      ? undefined
      : new ArticleStoreService({
          paths,
          ...(redis ? { redis: redis as unknown as SignalRedisIndexClient } : {}),
        });

    try {
      for (const article of legacyArticles) {
        let sourceId = tryResolveSourceId(aliasToId, article.sourceLabel, article.folderName);

        if (!sourceId) {
          const fallbackSource = createFallbackSource(article, mergedConfig);
          mergedConfig = SignalSourceConfigSchema.parse({
            version: 1,
            sources: [...mergedConfig.sources, fallbackSource],
          }) as SignalSourceConfig;
          sourceId = fallbackSource.id;

          aliasToId.set(slugify(article.folderName), sourceId);
          if (article.sourceLabel) {
            aliasToId.set(slugify(article.sourceLabel), sourceId);
          }
          fallbackSources += 1;
        }

        const source = mergedConfig.sources.find((item) => item.id === sourceId);
        if (!source) {
          skippedArticles += 1;
          continue;
        }

        if (args.dryRun) {
          migratedArticles += 1;
          continue;
        }

        if (!store) {
          skippedArticles += 1;
          continue;
        }

        await store.store({
          source,
          article: {
            title: article.title,
            url: article.url,
            publishedAt: article.publishedAt,
            ...(article.summary ? { summary: article.summary } : {}),
            ...(article.content ? { content: article.content } : {}),
          },
          ...(article.id ? { articleId: article.id } : {}),
          fetchedAt: article.fetchedAt,
          status: article.status,
          tags: article.tags,
        });
        migratedArticles += 1;
      }

      if (!args.dryRun) {
        await saveSignalSources(mergedConfig, paths);
      }

      io.log(
        formatMigrateSignalsSummary({
          dryRun: args.dryRun,
          legacyRoot,
          targetRoot: paths.rootDir,
          mergedSources: mergedConfig.sources.length,
          fallbackSources,
          migratedArticles,
          skippedArticles,
        }),
      );

      return 0;
    } finally {
      if (redis) {
        redis.disconnect(false);
      }
    }
  } catch (error) {
    io.error(`[signals] migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
