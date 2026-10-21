import type { SourceScope } from './approved-scope.js';
import type { Source, SourceModules } from './archive.js';
import { type PureSourceHelpers, type Reader, readEligibleTask } from './eligible-task.js';

export type { PureSourceHelpers } from './eligible-task.js';

/** Real index pages, never a substituted ZCARD/ZRANGE projection. */
async function readKindIndex(reader: Reader, index: string, helpers: PureSourceHelpers) {
  const count = helpers.values.number(await reader.read('ZCARD', index));
  if (count > 10000) throw new Error('Task index exceeds bounded source scope');
  const ids: string[] = [];
  for (let offset = 0; offset < count; offset += 256) {
    const page = await reader.read('ZRANGE', index, String(offset), String(Math.min(offset + 255, count - 1)));
    if (!Array.isArray(page) || page.length !== Math.min(256, count - offset))
      throw new Error('Task index changed during source read');
    for (const value of page) {
      if (typeof value !== 'string') throw new Error('Invalid task index');
      ids.push(helpers.values.identifier(value));
    }
  }
  if (new Set(ids).size !== count) throw new Error('Task index repeated during source read');
  return { count, ids };
}

async function eligibleTasks(
  reader: Reader,
  scope: SourceScope,
  signal: AbortSignal,
  helpers: PureSourceHelpers,
  digest: SourceModules['sourceDigest'],
) {
  const tasks: unknown[] = [],
    receipts: unknown[] = [],
    refs: string[] = [],
    census: unknown[] = [];
  for (const kind of ['pr_tracking', 'issue_tracking']) {
    const index = `${scope.keyPrefix}tasks:kind:${kind}`;
    const { count, ids } = await readKindIndex(reader, index, helpers);
    for (const id of ids) {
      signal.throwIfAborted();
      const row = await readEligibleTask(reader, scope, id, kind, helpers, digest);
      census.push(row.census);
      if ('task' in row) {
        tasks.push(row.task);
        if (row.receipt) receipts.push(row.receipt);
        refs.push(...row.refs);
      }
    }
    if (helpers.values.number(await reader.read('ZCARD', index)) !== count) throw new Error('Task membership changed');
  }
  return { tasks, receipts, refs, census };
}

export async function collectEligibleGitHubSource(
  reader: Reader,
  scope: SourceScope,
  signal: AbortSignal,
  helpers: PureSourceHelpers,
  sourceDigest: SourceModules['sourceDigest'],
): Promise<Source> {
  const tasks = await eligibleTasks(reader, scope, signal, helpers, sourceDigest);
  const repos = await helpers.legacyRepositories(reader, scope, signal);
  signal.throwIfAborted();
  return {
    v: 1,
    id: `legacy-redis:${sourceDigest({ scope, census: tasks.census, claims: repos.claims })}`,
    userId: scope.ownerUserId,
    sourceRef: scope.sourceRef,
    capturedAt: Date.now(),
    oldWriter: 'absent',
    coverage: {
      tracking: 'complete',
      repositories: 'complete',
      progress: 'complete',
      'pending-receipts': 'complete',
      'authority-retention': 'complete',
    },
    tasks: tasks.tasks,
    repositories: repos.repositories,
    receipts: tasks.receipts,
    retainedAuthorityRefs: [scope.oldWriterProofRef, ...tasks.refs],
    unresolvedRepositoryDeliveries: repos.unresolved,
  };
}
