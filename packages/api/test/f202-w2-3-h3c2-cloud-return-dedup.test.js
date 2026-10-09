/**
 * F202 W2-3 h3c-2 — the polled reply ingest answers to the configured cloud cat too, and the two
 * return entries (Remote MCP callback, polled ingest) land one reply per source whichever arrives
 * first, and however they interleave (ledger「h3c 实现设计」h3c-2; astra `…000188`, negative case 2:
 * both arrival orders and a concurrent race — not just "they share a key builder").
 *
 * The races are driven, not hoped for: the harness pauses one entry right after it claimed the grant
 * (before its append) or right after its append (before the grant commit), then lets the other in.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { CloudAssistantReturnIngestService } from '../dist/domains/cats/services/cloud-bridge/cloud-assistant-return-ingest.js';
import {
  CloudReturnGrantRetentionMs,
  MemoryCloudReturnGrantStore,
  RedisCloudReturnGrantStore,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { buildCloudReturnMessageIdempotencyKey } from '../dist/domains/cats/services/cloud-bridge/cloud-return-message.js';
import {
  bindSourceInRedis,
  cloudReturnSourceKey,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-source-binding.js';
import { cloudReturnHarness, configureCats } from './helpers/cloud-return-harness.js';

beforeEach(() => configureCats(['cloud-alt']));

async function withCloudKey() {
  const h = await cloudReturnHarness();
  const { secret } = await h.agentKeyRegistry.issue('cloud-alt', 'alice', { scope: 'cloud-conversation' });
  const mcp = (content, sourceMessageId = h.source.id) => h.post(secret, { content, replyTo: sourceMessageId });
  return { ...h, mcp };
}

async function onlyReply(h, sourceMessageId = h.source.id) {
  const replies = await h.repliesTo(sourceMessageId);
  assert.equal(replies.length, 1, `exactly one reply to ${sourceMessageId}`);
  return replies[0];
}

// ── The ingest follows the configuration ──

test('the ingest persists the reply as the configured cloud cat, under the shared exact-source key', async () => {
  const h = await cloudReturnHarness();
  await h.grant('cloud-alt');

  const outcome = await h.ingest(h.source.id, 'polled answer');

  assert.equal(outcome.status, 'persisted');
  const reply = await onlyReply(h);
  assert.equal(reply.catId, 'cloud-alt');
  assert.equal(reply.id, outcome.messageId);
  const key = buildCloudReturnMessageIdempotencyKey(h.scope('cloud-alt'));
  assert.equal((await h.messageStore.getByIdempotencyKey('alice', h.thread.id, key)).id, reply.id);
  assert.equal(h.broadcasts.at(-1).message.catId, 'cloud-alt');
  assert.deepEqual(await h.grantStore.claim(h.scope('cloud-alt')), { ok: false, reason: 'consumed' });
});

test('the ingest refuses the wrong cat, the wrong thread, an unknown source, and no grant', async () => {
  const h = await cloudReturnHarness();
  await h.grant('gpt-pro');
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'grant_not_found' });

  await h.grant('cloud-alt', h.source.id, h.otherThread.id);
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'grant_not_found' });

  assert.deepEqual(await h.ingest('no-such-message', 'x'), { status: 'rejected', reason: 'source_not_found' });
  assert.deepEqual(await h.ingest(h.unGranted.id, 'x'), { status: 'rejected', reason: 'grant_not_found' });
  assert.equal((await h.posted('x')).length, 0);
});

test('with no cloud cat the provider is unavailable; with several it is refused, naming them', async () => {
  configureCats([]);
  let h = await cloudReturnHarness();
  await h.grant('cloud-alt');
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'cloud_cat_unavailable' });

  configureCats(['cloud-alt', 'cloud-beta']);
  h = await cloudReturnHarness();
  await h.grant('cloud-alt');
  assert.deepEqual(await h.ingest(h.source.id, 'x'), { status: 'rejected', reason: 'cloud_cat_ambiguous' });
  assert.deepEqual(h.warnings.at(-1).context.catIds, ['cloud-alt', 'cloud-beta']);
  assert.equal((await h.posted('x')).length, 0);
  assert.equal(
    (await h.grantStore.claim(h.scope('cloud-alt'))).ok,
    true,
    'the grant is left for a fixed configuration',
  );
});

test('a reply in flight while the cloud cat is renamed is refused, not re-attributed to the new cat', async () => {
  const h = await cloudReturnHarness();
  await h.grant('cloud-alt');

  configureCats(['cloud-beta']);
  assert.deepEqual(await h.ingest(h.source.id, 'late answer'), { status: 'rejected', reason: 'grant_not_found' });
  assert.equal((await h.posted('late answer')).length, 0);
  assert.equal((await h.grantStore.claim(h.scope('cloud-alt'))).ok, true);
});

// ── Negative case 2: one reply per source, in either order and under a race ──

test('Remote MCP first, then the poll: the poll is a duplicate of the MCP reply', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');

  assert.equal((await h.mcp('via MCP')).statusCode, 200);
  const polled = await h.ingest(h.source.id, 'via the page');

  const reply = await onlyReply(h);
  assert.deepEqual(polled, { status: 'duplicate', messageId: reply.id });
  assert.equal(reply.content, 'via MCP');
});

test('the poll first, then Remote MCP: the callback is a duplicate of the polled reply', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');

  assert.equal((await h.ingest(h.source.id, 'via the page')).status, 'persisted');
  const response = await h.mcp('via MCP');

  const reply = await onlyReply(h);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'duplicate');
  assert.equal(response.json().messageId, reply.id);
  assert.equal(reply.content, 'via the page');
});

test('race: the poll arrives while Remote MCP holds the grant, and retries into the duplicate', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');
  const paused = h.pauseAppend();
  const mcp = h.mcp('via MCP');
  await paused.reached;

  assert.deepEqual(await h.ingest(h.source.id, 'via the page'), { status: 'retry', reason: 'grant_in_flight' });
  paused.release();
  assert.equal((await mcp).statusCode, 200);

  const reply = await onlyReply(h);
  assert.deepEqual(await h.ingest(h.source.id, 'via the page'), { status: 'duplicate', messageId: reply.id });
  assert.equal(reply.content, 'via MCP');
});

test('race: Remote MCP arrives while the poll holds the grant, and retries into the duplicate', async () => {
  const h = await withCloudKey();
  await h.grant('cloud-alt');
  const paused = h.pauseAppend();
  const polled = h.ingest(h.source.id, 'via the page');
  await paused.reached;

  const early = await h.mcp('via MCP');
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().kind, 'cloud_return_grant_in_flight');
  paused.release();
  assert.equal((await polled).status, 'persisted');

  const reply = await onlyReply(h);
  const retried = await h.mcp('via MCP');
  assert.equal(retried.json().status, 'duplicate');
  assert.equal(retried.json().messageId, reply.id);
  assert.equal(reply.content, 'via the page');
});

test('race: whichever entry appended first wins even before its grant commit lands', async () => {
  for (const first of ['mcp', 'poll']) {
    const h = await withCloudKey();
    await h.grant('cloud-alt');
    const paused = h.pauseCommit();
    const winner = first === 'mcp' ? h.mcp('via MCP') : h.ingest(h.source.id, 'via the page');
    await paused.reached;

    const [reply] = await h.repliesTo(h.source.id);
    if (first === 'mcp') {
      assert.deepEqual(await h.ingest(h.source.id, 'via the page'), { status: 'duplicate', messageId: reply.id });
    } else {
      const late = await h.mcp('via MCP');
      assert.equal(late.json().status, 'duplicate', late.body);
      assert.equal(late.json().messageId, reply.id);
    }
    paused.release();
    await winner;
    assert.equal((await onlyReply(h)).id, reply.id, `${first} first`);
    assert.deepEqual(await h.grantStore.claim(h.scope('cloud-alt')), { ok: false, reason: 'consumed' });
  }
});

test('race: both entries released together, in both start orders, still land one reply per source', async () => {
  const h = await withCloudKey();
  const sources = [];
  for (let index = 0; index < 20; index += 1) {
    const source = h.append(`source ${index}`);
    await h.grant('cloud-alt', source.id);
    sources.push(source);
  }

  await Promise.all(
    sources.map(async (source, index) => {
      const entries = [() => h.mcp(`via MCP ${index}`, source.id), () => h.ingest(source.id, `via the page ${index}`)];
      if (index % 2 === 1) entries.reverse();
      await Promise.all(entries.map((start) => start()));
      // A loser that met the grant in flight settles on its next attempt.
      await h.mcp(`via MCP ${index}`, source.id);
      await h.ingest(source.id, `via the page ${index}`);
    }),
  );

  for (const source of sources) {
    const reply = await onlyReply(h, source.id);
    assert.equal(reply.catId, 'cloud-alt');
    assert.deepEqual(await h.ingest(source.id, 'again'), { status: 'duplicate', messageId: reply.id });
  }
});

// ── P1-3 (astra, h3c-2 review and re-reviews): one source, one cloud cat, for good ──
// A polled return carries no dispatch identity of its own, so a source's cat is fixed by its first
// grant for the source's whole life, and a source can take a first owner only when the Host can prove
// it is younger than the bindings — its Host-minted id says when it was created. Older sources keep
// the owner their surviving grants prove, or none at all.

/** Redis command semantics in memory (GET, SET with NX/XX/PX, SCAN MATCH, the grant refresh script). */
function redisDouble() {
  const values = new Map();
  const calls = { set: [], scan: 0 };
  return {
    values,
    calls,
    async set(key, value, ...options) {
      calls.set.push({ key, options });
      const exists = values.has(key);
      if ((options.includes('NX') && exists) || (options.includes('XX') && !exists)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async scan(_cursor, _match, pattern) {
      calls.scan += 1;
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...values.keys()].filter((key) => key.startsWith(prefix))];
    },
    // Only the grant store's refresh of an existing grant runs a script here: same scope → refreshed.
    async eval(_script, _keyCount, key, threadId, userId, sourceMessageId, targetCatId) {
      const stored = JSON.parse(values.get(key) ?? 'null');
      if (!stored) return 0;
      const same =
        stored.threadId === threadId &&
        stored.userId === userId &&
        stored.sourceMessageId === sourceMessageId &&
        stored.targetCatId === targetCatId;
      return same ? 1 : -1;
    },
  };
}

let sequence = 0;
/** A message id as the Host mints it, created `offsetMs` from now (negative: before the bindings). */
const hostMessageId = (offsetMs = 3_600_000) =>
  `${String(Date.now() + offsetMs).padStart(16, '0')}-${String(++sequence).padStart(6, '0')}-abcdef01`;
const HOUR = 3_600_000;

/** A grant exactly as the version before source bindings persisted it. */
function persistV1Grant(redis, scope) {
  const key = `cloud-bridge:return-grant:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
  const record = { v: 1, ...scope, dispatchInvocationId: 'old-dispatch', status: 'pending', issuedAt: 1 };
  redis.values.set(key, JSON.stringify(record));
}

const scopeOf = (sourceMessageId, targetCatId) => ({ threadId: 't', userId: 'alice', sourceMessageId, targetCatId });
const issueTo = (grants, sourceMessageId, targetCatId, dispatchInvocationId = 'inv') =>
  grants.issue({ ...scopeOf(sourceMessageId, targetCatId), dispatchInvocationId });

for (const [name, store] of [
  ['memory', () => new MemoryCloudReturnGrantStore()],
  ['redis', () => new RedisCloudReturnGrantStore(redisDouble())],
]) {
  test(`${name}: a new source granted to one cloud cat is never granted to another`, async () => {
    const grants = store();
    const source = hostMessageId();
    assert.deepEqual(await issueTo(grants, source, 'cloud-alt'), { ok: true, status: 'issued' });
    assert.deepEqual(await issueTo(grants, source, 'cloud-beta', 'inv-2'), {
      ok: false,
      reason: 'source_retargeted',
      boundTargetCatId: 'cloud-alt',
    });
    assert.equal((await grants.claim(scopeOf(source, 'cloud-beta'))).ok, false);
    assert.deepEqual(await issueTo(grants, source, 'cloud-alt', 'inv-3'), { ok: true, status: 'existing' });
    assert.deepEqual(await issueTo(grants, hostMessageId(), 'cloud-beta'), { ok: true, status: 'issued' });
  });

  test(`${name}: a source older than the bindings, or not a Host message, takes no first owner`, async () => {
    const grants = store();
    assert.deepEqual(await issueTo(grants, hostMessageId(-HOUR), 'cloud-alt'), {
      ok: false,
      reason: 'source_history_unknown',
    });
    assert.deepEqual(await issueTo(grants, 'not-a-host-message-id', 'cloud-alt'), {
      ok: false,
      reason: 'source_history_unknown',
    });
  });
}

test('P1-3: after a rename the source cannot move to the new cat, and the old answer is refused', async () => {
  const h = await cloudReturnHarness();
  await h.grant('cloud-alt');

  configureCats(['cloud-beta']);
  assert.deepEqual(await h.grant('cloud-beta'), {
    ok: false,
    reason: 'source_retargeted',
    boundTargetCatId: 'cloud-alt',
  });
  assert.deepEqual(await h.ingest(h.source.id, 'the old answer'), { status: 'rejected', reason: 'grant_not_found' });
  assert.equal((await h.posted('the old answer')).length, 0);
  assert.equal((await h.grantStore.claim(h.scope('cloud-alt'))).ok, true, 'the old grant is not consumed either');
});

test('P1-3 expiry: the owner outlives every grant — a day later a new cat is still refused', async () => {
  let now = Date.now();
  const grants = new MemoryCloudReturnGrantStore(() => now);
  const source = hostMessageId();
  await issueTo(grants, source, 'cloud-alt');

  now += CloudReturnGrantRetentionMs + 1;
  assert.equal((await grants.claim(scopeOf(source, 'cloud-alt'))).ok, false, 'the grant itself has lapsed');
  assert.deepEqual(await issueTo(grants, source, 'cloud-beta', 'inv-2'), {
    ok: false,
    reason: 'source_retargeted',
    boundTargetCatId: 'cloud-alt',
  });
  assert.deepEqual(
    await issueTo(grants, source, 'cloud-alt', 'inv-3'),
    { ok: true, status: 'issued' },
    'the owner can be granted again',
  );
});

test('P1-3 upgrade: a grant persisted before bindings keeps its source for its cat', async () => {
  const redis = redisDouble();
  const source = hostMessageId(-HOUR);
  persistV1Grant(redis, scopeOf(source, 'gpt-pro'));
  const grants = new RedisCloudReturnGrantStore(redis);

  assert.deepEqual(await issueTo(grants, source, 'cloud-beta', 'new'), {
    ok: false,
    reason: 'source_retargeted',
    boundTargetCatId: 'gpt-pro',
  });
  assert.equal((await grants.claim(scopeOf(source, 'cloud-beta'))).ok, false);
  assert.equal((await grants.claim(scopeOf(source, 'gpt-pro'))).ok, true, 'the old dispatch can still be answered');
});

test('P1-3 upgrade: a source two persisted grants disagree about belongs to neither', async () => {
  const redis = redisDouble();
  const source = hostMessageId(-HOUR);
  persistV1Grant(redis, scopeOf(source, 'gpt-pro'));
  persistV1Grant(redis, scopeOf(source, 'cloud-beta'));
  const grants = new RedisCloudReturnGrantStore(redis);

  assert.equal((await grants.claim(scopeOf(source, 'gpt-pro'))).ok, false);
  assert.equal((await grants.claim(scopeOf(source, 'cloud-beta'))).ok, false);
  assert.deepEqual(await issueTo(grants, source, 'cloud-beta', 'new'), { ok: false, reason: 'source_history_unknown' });
});

test('P1-3 upgrade: a source whose grant lapsed before the upgrade is not taken for new — its late answer stays unattributed', async () => {
  const h = await cloudReturnHarness();
  configureCats(['cloud-beta']);
  // The old Host sent h.source to gpt-pro; the grant expired before the upgrade, so nothing of it is left
  // in Redis — but the answer still waits in the native inbox.
  const grants = new RedisCloudReturnGrantStore(redisDouble());
  assert.deepEqual(await grants.issue({ ...h.scope('cloud-beta'), dispatchInvocationId: 'new' }), {
    ok: false,
    reason: 'source_history_unknown',
  });
  const ingest = new CloudAssistantReturnIngestService({
    messageStore: h.messageStore,
    grantStore: grants,
    socketManager: { broadcastAgentMessage() {} },
    logger: { warn() {}, error() {} },
    cats: catRegistry,
  });
  assert.deepEqual(
    await ingest.ingest({ provider: 'chatgpt', sourceMessageId: h.source.id, content: 'late gpt-pro answer' }),
    {
      status: 'rejected',
      reason: 'grant_not_found',
    },
  );
  assert.equal((await h.repliesTo(h.source.id)).length, 0);
  await h.app.close();
});

test('P1-3 upgrade: the epoch is recorded once and read back — never re-derived by a later start', async () => {
  const redis = redisDouble();
  redis.values.set('cloud-bridge:return-source:epoch', String(Date.now() - 2 * HOUR));
  const grants = new RedisCloudReturnGrantStore(redis);

  assert.deepEqual(await issueTo(grants, hostMessageId(-HOUR), 'cloud-alt'), { ok: true, status: 'issued' });
  assert.deepEqual(await issueTo(grants, hostMessageId(-3 * HOUR), 'cloud-alt'), {
    ok: false,
    reason: 'source_history_unknown',
  });
});

test('P1-3 upgrade: persisted grants are recovered once per database, before the first admission', async () => {
  const redis = redisDouble();
  const old = hostMessageId(-HOUR);
  persistV1Grant(redis, scopeOf(old, 'gpt-pro'));
  await issueTo(new RedisCloudReturnGrantStore(redis), hostMessageId(), 'gpt-pro');
  assert.equal(redis.calls.scan, 1);

  const restarted = new RedisCloudReturnGrantStore(redis);
  await issueTo(restarted, hostMessageId(), 'gpt-pro');
  assert.equal(redis.calls.scan, 1, 'the migration marker spares every later start');
  assert.equal((await restarted.claim(scopeOf(old, 'gpt-pro'))).ok, true);
});

test('P1-3 restart without Redis: bindings start with the process, so earlier sources take no first owner', async () => {
  const grants = new MemoryCloudReturnGrantStore(Date.now, { historyBoundary: Date.now() });
  assert.deepEqual(await issueTo(grants, hostMessageId(-HOUR), 'cloud-alt'), {
    ok: false,
    reason: 'source_history_unknown',
  });
  assert.deepEqual(await issueTo(grants, hostMessageId(), 'cloud-alt'), { ok: true, status: 'issued' });
});

test('P1-3 contention: of two cats racing for a fresh source exactly one wins, and nothing ever expires or overwrites', async () => {
  const redis = redisDouble();
  const epoch = Date.now();
  const source = scopeOf(hostMessageId(), 'cloud-alt');
  const [alt, beta] = await Promise.all([
    bindSourceInRedis(redis, source, epoch),
    bindSourceInRedis(redis, { ...source, targetCatId: 'cloud-beta' }, epoch),
  ]);
  assert.equal([alt, beta].filter((binding) => binding.bound).length, 1);

  const grants = new RedisCloudReturnGrantStore(redis);
  await issueTo(grants, hostMessageId(), 'cloud-alt');
  const sourceWrites = redis.calls.set.filter(({ key }) => key.startsWith('cloud-bridge:return-source:'));
  assert.ok(sourceWrites.length > 0);
  for (const { options } of sourceWrites) {
    assert.ok(!options.includes('XX') && !options.includes('PX'), `a source write never refreshes: ${options}`);
  }
});

test('P1-3 contention: a binding that vanished after a lost SET NX names no owner and admits nobody', async () => {
  const redis = redisDouble();
  const source = scopeOf(hostMessageId(), 'cloud-alt');
  const key = cloudReturnSourceKey(source);
  redis.values.set(key, 'cloud-beta');
  let reads = 0;
  const get = redis.get.bind(redis);
  redis.get = async (read) => {
    if (read === key && ++reads === 1) return null; // looked unowned, then lost the SET NX race…
    if (read === key) redis.values.delete(key); // …and the winner's binding is gone when read back
    return get(read);
  };
  assert.deepEqual(await bindSourceInRedis(redis, source, 0), { bound: false, owner: null });
});
