/**
 * F102 Phase B: rebuild-index CLI
 * Scans docs/, parses frontmatter, rebuilds evidence.sqlite FTS index.
 *
 * Usage: pnpm --filter @cat-cafe/api rebuild-index [--force]
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexBuilder } from '../domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../domains/memory/SqliteEvidenceStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('rebuild-index');

interface RebuildIndexArgs {
  force: boolean;
  docsRoot: string;
  dbPath: string;
}

function parseArgs(argv: string[]): RebuildIndexArgs {
  const force = argv.includes('--force');
  const docsRoot = join(process.cwd(), 'docs');
  const dbPath = join(process.cwd(), 'data', 'evidence.sqlite');
  return { force, docsRoot, dbPath };
}

export async function runRebuildIndexCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  log.info({ docs: args.docsRoot, db: args.dbPath, force: args.force }, 'Rebuild index starting');

  const store = new SqliteEvidenceStore(args.dbPath);
  await store.initialize();

  const builder = new IndexBuilder(store, args.docsRoot);

  const result = await builder.rebuild({ force: args.force });

  log.info(
    { docsIndexed: result.docsIndexed, docsSkipped: result.docsSkipped, durationMs: result.durationMs },
    'Index rebuilt',
  );

  const consistency = await builder.checkConsistency();
  if (!consistency.ok) {
    log.error({ docCount: consistency.docCount, ftsCount: consistency.ftsCount }, 'CONSISTENCY ERROR');
    process.exitCode = 1;
  } else {
    log.info({ docCount: consistency.docCount }, 'Consistency check passed');
  }

  store.close();
}

// Direct invocation
const entryPath = process.argv[1];
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runRebuildIndexCli().catch((err) => {
    log.error({ error: err }, 'Fatal error');
    process.exitCode = 1;
  });
}
