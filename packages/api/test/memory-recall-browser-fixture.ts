/** Read-only browser samples from real route injection; no listener, Redis or runtime. */
import { RECALL_RESOLVER_FAMILIES, type RecallResolverFamily } from '@cat-cafe/shared';
import { recallFixture } from './memory-recall-fixture.js';

type SampleKind = 'ready' | 'empty' | 'error' | 'partial' | 'pagination';
type Fixture = Awaited<ReturnType<typeof recallFixture>>;
type Routes = Record<string, { status: number; body: unknown }>;
function nameThread(f: Fixture, id: string, title: string) {
  const thread = f.threads.get(id);
  if (!thread) throw new Error('Missing fixture thread');
  thread.title = title;
}
function sourceAnchor(family: RecallResolverFamily) {
  if (family === 'person_entity') return 'person-memory:person_visible';
  if (['decision', 'project_knowledge', 'operational_precedent'].includes(family)) return 'thread-system';
  return `source-${family}`;
}
function seedDeliveries(f: Fixture) {
  f.invocation('cue-parent');
  for (const family of RECALL_RESOLVER_FAMILIES) {
    const event = {
      eventId: `cue-${family}`,
      idempotencyKey: `present-${family}`,
      cueId: `cue-${family}`,
      opportunityId: `opportunity-${family}`,
      scope: { ownerUserId: 'owner', threadId: 'own', invocationId: 'cue-parent' },
      consumerCatId: 'sonnet',
      resolverFamily: family,
      sourceAnchor: sourceAnchor(family),
      sourceRevision: 'revision-1',
      axis: 'consumption' as const,
      consumptionOutcome: 'presented' as const,
      catalogVersion: 1,
      resolverVersion: 1,
      occurredAt: f.now - 200,
    };
    f.episodes.append(event);
    if (family === 'taste')
      f.episodes.append({
        ...event,
        eventId: 'taste-applied',
        idempotencyKey: 'taste-applied',
        consumptionOutcome: 'applied',
        occurredAt: f.now - 100,
      });
  }
  f.replies.set('own', [
    { id: 'reply-cue', catId: 'sonnet', timestamp: f.now - 50, extra: { stream: { invocationId: 'cue-parent' } } },
    {
      id: 'reply-pull',
      catId: 'codex61-sol',
      timestamp: f.now - 500,
      extra: { stream: { invocationId: 'inv-pull-visible' } },
    },
  ]);
}
function seedDetailRows(f: Fixture) {
  f.recall('pull-visible', {
    query: '记忆页的窄屏规则',
    cat: 'codex61-sol',
    candidates: JSON.stringify([{ anchor: 'thread-system' }]),
  });
  f.db
    .prepare(
      "UPDATE recall_events SET result_count=1,result_status='counted',inspected=1,consumed_json=? WHERE recall_id='pull-visible'",
    )
    .run(JSON.stringify([{ anchor: 'thread-system' }]));
  f.recall('pull-other-thread', {
    query: '召回窗口与来源的关系',
    thread: 'system',
    cat: 'sonnet',
    timestamp: f.now - 8000,
  });
  f.db
    .prepare(
      "UPDATE recall_events SET tool_name='graph_resolve',candidates_json=?,result_count=2,result_status='counted',inspected=1,consumed_json=? WHERE recall_id='pull-other-thread'",
    )
    .run(
      JSON.stringify([{ anchor: 'thread-system' }, { anchor: 'thread-own' }]),
      JSON.stringify([{ anchor: 'thread-system' }]),
    );
  f.replies.set('system', [
    {
      id: 'reply-graph',
      catId: 'sonnet',
      timestamp: f.now - 7900,
      extra: { stream: { invocationId: 'inv-pull-other-thread' } },
    },
  ]);
  f.recall('generic-context', { query: '通用上下文递送', source: 'push', timestamp: f.now - 10000 });
  f.recall('older', { query: '上周的召回口径', timestamp: f.now - 9 * 86400000 });
  f.recall('oldest', { query: '更早的布局讨论', timestamp: f.now - 24 * 86400000 });
  seedDeliveries(f);
}
async function readPages(f: Fixture, routes: Routes, query: string) {
  let suffix = query;
  let pages = 0;
  while (true) {
    if (++pages > 3) throw new Error('Fixture cursor failed to advance');
    const response = await f.get(suffix);
    const body = response.json();
    routes[`/api/memory/recall${suffix}`] = { status: response.statusCode, body };
    if (response.statusCode !== 200 || !body.nextCursor) return;
    suffix = `${query}&cursor=${encodeURIComponent(body.nextCursor)}`;
  }
}
async function readRoutes(f: Fixture): Promise<Routes> {
  const routes: Routes = {};
  for (const days of [7, 14, 30]) {
    const stats = await f.app.inject({
      url: `/api/memory/recall/stats?days=${days}`,
      headers: { 'x-test-session': 'owner' },
    });
    routes[`/api/memory/recall/stats?days=${days}`] = { status: stats.statusCode, body: stats.json() };
    for (const source of ['all', 'pull', 'push'])
      for (const catId of ['', 'sonnet', 'codex61-sol'])
        await readPages(f, routes, `?days=${days}&source=${source}${catId ? `&catId=${catId}` : ''}`);
  }
  return routes;
}
async function sample(kind: SampleKind) {
  const f = await recallFixture((readers) => {
    readers.personMemoryStore = {
      getPerson: async () => ({ ownerUserId: 'owner', displayName: '已批准的人物记忆', status: 'active' }),
    };
    readers.cueSourceReader = {
      read: async () =>
        kind === 'partial'
          ? { status: 'not_available' }
          : {
              status: 'ok',
              payload: {
                vignette: { when: '先看真实页面，再讨论布局' },
                summary: '一起核对召回的显示规则',
                profileUri: 'cat-cafe-profile://corpus/current',
              },
            },
    };
    if (kind === 'error') readers.threadStore = undefined;
  });
  try {
    nameThread(f, 'own', '记忆页的共创');
    nameThread(f, 'system', '搜索入口的讨论');
    f.indexed.push('system');
    // Each sample has its own fresh database. Pagination never edits immutable cue history.
    if (kind === 'pagination')
      for (let i = 0; i < 55; i++) f.recall(`page-${i}`, { query: `分页检索 ${i + 1}`, timestamp: f.now - 1000 - i });
    else if (kind === 'ready' || kind === 'partial') seedDetailRows(f);
    return await readRoutes(f);
  } finally {
    await f.close();
  }
}
const kinds: SampleKind[] = ['ready', 'empty', 'error', 'partial', 'pagination'];
const samples = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await sample(kind)])));
console.log(`F321_FIXTURE_JSON=${JSON.stringify(samples)}`);
