import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSON_MEMORY_LIMITS } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { PersonMemoryRecallService } from '../src/domains/memory/people/PersonMemoryRecallService.ts';
import { applyMigrations } from '../src/domains/memory/schema.ts';
import { registerCallbackPersonMemoryRoutes } from '../src/routes/callback-person-memory-routes.ts';

const catA = 'codex61-sol';
const catB = 'codex61-terra';

function fixture(t, statement = 'Synthetic judgment') {
  const db = new Database(':memory:');
  applyMigrations(db);
  const app = Fastify();
  // Only the test auth adapter chooses principals; no identity comes from the drill body.
  app.addHook('preHandler', async (req) => {
    const identity = { userId: req.headers['x-owner'] ?? 'owner', catId: req.headers['x-cat'] ?? catA };
    req.callbackPrincipal = req.headers['x-agent-key']
      ? {
          ...identity,
          kind: 'agent_key',
          agentKeyId: req.headers['x-agent-key'],
          scope: 'user-bound',
          cloudBoundary: false,
        }
      : {
          ...identity,
          kind: 'invocation',
          invocationId: req.headers['x-child'] ?? 'child-first',
          parentInvocationId: req.headers['x-parent'] ?? 'parent-shared',
          threadId: req.headers['x-thread'] ?? 'thread_shared',
        };
  });
  const service = new PersonMemoryRecallService(
    {
      getPerson: async (ownerUserId, personId) => ({
        personId,
        ownerUserId,
        status: 'active',
        displayName: 'Synthetic',
        privateAliases: [],
        createdAt: 1,
      }),
      listClaims: async (ownerUserId, personId) => [
        {
          claimId: `person_claim_${personId}`,
          personId,
          ownerUserId,
          status: 'current',
          recordedAt: 1,
          payload: { kind: 'user_assessment', statement },
          materializedBy: { kind: 'card_approval' },
          sourceRefs: [{ kind: 'message', threadId: 'thread_source', messageId: 'message_source' }],
        },
      ],
      listRelationships: async () => [],
      listInteractionEvents: async () => [],
    },
    {},
  );
  registerCallbackPersonMemoryRoutes(app, { store: {}, readEvidenceDb: db, recallService: service });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const drill = async (readRequestId, headers = {}, personId = 'person_fixture') => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/drill',
      headers,
      payload: {
        personId,
        item: { kind: 'claim', id: `person_claim_${personId}` },
        timeWindow: { from: 0, to: 100 },
        readRequestId,
      },
    });
    return { http: response.statusCode, ...response.json() };
  };
  const counts = () =>
    db
      .prepare(`SELECT r.consumer_cat_id cat, COUNT(*) n FROM memory_direct_read_events e
    JOIN memory_direct_read_requests r ON r.request_key = e.request_key GROUP BY r.consumer_cat_id ORDER BY cat`)
      .all();
  return { drill, counts, db };
}

test('parallel cats each receive three reads; the same ID belongs to its cat and refreshed children only replay', async (t) => {
  const f = fixture(t);
  for (const cat of [catA, catB]) {
    const caller = { 'x-cat': cat };
    for (let i = 1; i <= 3; i++) {
      const id = cat === catA || i === 1 ? `read-${i}` : `b-read-${i}`;
      const result = await f.drill(id, { ...caller, 'x-child': `child-${i}` });
      assert.equal(result.http, 200);
      assert.equal(result.status, 'ok', `${cat} owns its first three reads under the shared parent`);
      assert.equal(result.usageRecorded, true);
    }
    const replay = await f.drill('read-1', { ...caller, 'x-child': 'child-refreshed' });
    assert.equal(replay.http, 200);
    assert.equal(replay.status, 'ok', 'a replay remains available after the third successful read');
    assert.equal((await f.drill('read-4', { ...caller, 'x-child': 'child-next' })).status, 'budget_exceeded');
  }
  assert.deepEqual(f.counts(), [
    { cat: catA, n: 3 },
    { cat: catB, n: 3 },
  ]);
});

test('the aggregate token cap spans people and children for one cat while another cat keeps its own allowance', async (t) => {
  const f = fixture(t, '合成读取预算。'.repeat(500));
  const totalByCat = [];
  for (const cat of [catA, catB]) {
    let total = 0;
    let reads = 0;
    let capped = false;
    for (let i = 0; i < 10; i++) {
      const headers = { 'x-cat': cat, 'x-child': `child-${i}` };
      const id = `${cat}-token-${i}`;
      const result = await f.drill(id, headers, `person_token_${i}`);
      assert.equal(result.http, 200);
      if (result.status === 'budget_exceeded') {
        assert(reads > 0, `${cat} must get content before its own allowance is exhausted`);
        assert(total + total / reads > PERSON_MEMORY_LIMITS.maxPersonMemoryTokensPerTurn);
        capped = true;
        break;
      }
      assert.equal(result.status, 'ok');
      assert(result.estimatedTokens > 0 && result.estimatedTokens <= PERSON_MEMORY_LIMITS.maxDrillTokensPerCall);
      total += result.estimatedTokens;
      reads++;
      assert(total <= PERSON_MEMORY_LIMITS.maxPersonMemoryTokensPerTurn);
      const replay = await f.drill(id, { ...headers, 'x-child': 'child-retry' }, `person_token_${i}`);
      assert.equal(replay.status, 'ok');
      assert.equal(replay.estimatedTokens, result.estimatedTokens);
    }
    assert(capped, 'fresh people cannot reset the aggregate token limit');
    totalByCat.push({ cat, reads, total });
  }
  assert.equal(totalByCat[0].total, totalByCat[1].total);
  assert.deepEqual(
    f.counts(),
    totalByCat.map(({ cat, reads }) => ({ cat, n: reads })),
  );
});

test('owner, thread and parent boundaries isolate budgets without allowing cross-origin request-ID reuse', async (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) assert.equal((await f.drill(`scope-${i}`)).status, 'ok');
  const thread = { 'x-thread': 'thread_other' };
  assert.equal((await f.drill('scope-1', thread)).http, 409, 'an old ID cannot impersonate another thread');
  for (let i = 1; i <= 3; i++) assert.equal((await f.drill(`thread-${i}`, thread)).status, 'ok');
  assert.equal((await f.drill('thread-4', thread)).status, 'budget_exceeded');
  const parent = { 'x-parent': 'parent_other' };
  assert.equal((await f.drill('scope-1', parent)).http, 409);
  assert.equal((await f.drill('parent-first', parent)).status, 'ok');
  assert.equal((await f.drill('scope-1', { 'x-owner': 'other-owner' })).status, 'ok');
});

test("agent-key and invocation callers cannot share budget coordinates or reuse each other's IDs", async (t) => {
  const f = fixture(t);
  const key = { 'x-agent-key': 'fixture-key' };
  for (let i = 1; i <= 3; i++) assert.equal((await f.drill(`key-${i}`, key)).status, 'ok');
  assert.equal((await f.drill('key-1', { ...key, 'x-cat': catB })).status, 'ok');
  const invocation = { 'x-parent': 'agent-key:fixture-key' };
  assert.equal((await f.drill('key-1', invocation)).http, 409);
  for (let i = 1; i <= 3; i++) assert.equal((await f.drill(`inv-${i}`, invocation)).status, 'ok');
  assert.equal((await f.drill('inv-4', invocation)).status, 'budget_exceeded');
  const otherKey = { 'x-agent-key': 'other-key' };
  assert.equal((await f.drill('key-1', otherKey)).http, 409);
  assert.equal((await f.drill('other-key-first', otherKey)).status, 'ok');
});
