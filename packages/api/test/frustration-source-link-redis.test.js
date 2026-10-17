import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisFrustrationIssueStore } from '../dist/domains/cats/services/stores/redis/RedisFrustrationIssueStore.js';
import { neutralFixture } from './helpers/neutral-host-fixture.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const url = process.env.REDIS_URL;
async function fixture(t, confirmed = true) {
  assertRedisIsolationOrThrow(url, 'F202 frustration link CAS');
  const keyPrefix = `f202-source-${randomUUID()}:`;
  const redis = createRedisClient({ url, keyPrefix });
  const peer = createRedisClient({ url, keyPrefix });
  t.after(async () => {
    await Promise.all([redis.quit(), peer.quit()]);
  });
  await Promise.all([redis.ping(), peer.ping()]);
  const store = new RedisFrustrationIssueStore(redis);
  const other = new RedisFrustrationIssueStore(peer);
  assert.equal(typeof store.compareAndSetCommunityIssueDraft, 'function', 'atomic Redis source link port missing');
  const draft = await store.create({
    threadId: 'thread',
    userId: 'owner',
    catId: 'cat-test',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'error' },
    context: { recentMessages: [], errorLogs: 'private' },
  });
  if (confirmed) await store.confirm({ issueId: draft.issueId, userDescription: 'description' });
  const source = await store.getById(draft.issueId);
  const input = {
    issueId: source.issueId,
    expectedSource: source,
    expectedDraftId: null,
    draftId: 'D1',
    allowReplace: false,
  };
  const key = `frustration-issue:${source.issueId}`;
  // Real second-client write after the first client's read, before its conditional write.
  function afterRead(action) {
    const original = redis.hgetall.bind(redis);
    redis.hgetall = async (...args) => {
      const fields = await original(...args);
      redis.hgetall = original;
      await action();
      return fields;
    };
  }
  return { redis, peer, store, other, source, input, key, afterRead };
}

describe('frustration source CAS on isolated Redis', { skip: redisIsolationSkipReason(url) }, () => {
  test('real owner module forwarding persists and replays a source link through Redis CAS', async (t) => {
    const storage = await fixture(t);
    const f = await neutralFixture(t, { store: storage.store });
    const response = await f.http('frustration', 'getSource', f.draft.issueId);
    assert.equal(response.statusCode, 200, response.body);
    const source = response.json().result;
    const input = {
      issueId: source.issueId,
      sourceRevision: source.sourceRevision,
      expectedDraftId: null,
      draftId: 'owner-D1',
    };
    const first = await f.http('frustration', 'linkDraft', input);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json().result, {
      outcome: 'linked',
      draftId: 'owner-D1',
      sourceRevision: source.sourceRevision,
    });
    const replay = await f.native('frustration', 'linkDraft', input);
    assert.equal(replay.result.outcome, 'already_linked');
    assert.equal((await storage.other.getById(source.issueId)).communityIssueDraftId, 'owner-D1');
    assert.equal(await storage.peer.ttl('frustration-issue:' + source.issueId), -1);
  });

  test('existing hash links and replays after store reconstruction without changing history or TTL', async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(f.input), { outcome: 'linked' });
    assert.deepEqual(await f.other.compareAndSetCommunityIssueDraft(f.input), { outcome: 'already_linked' });
    const saved = await f.other.getById(f.source.issueId);
    assert.deepEqual(saved, { ...f.source, communityIssueDraftId: 'D1' });
    assert.equal(await f.peer.ttl(f.key), -1);
    assert.equal((await f.other.listConfirmed('owner')).length, 1);
  });
  test('missing record is never created', async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft({ ...f.input, issueId: 'absent' }), {
      outcome: 'missing',
    });
    assert.equal(await f.peer.exists('frustration-issue:absent'), 0);
  });
  test('unconfirmed source cannot be linked', async (t) => {
    const f = await fixture(t, false);
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(f.input), { outcome: 'not_confirmed' });
    assert.equal(await f.peer.hget(f.key, 'communityIssueDraftId'), null);
  });
  test('same-link replay still checks ownership, content, and history snapshot', async (t) => {
    const f = await fixture(t);
    await f.store.compareAndSetCommunityIssueDraft(f.input);
    for (const delta of [
      { userId: 'other' },
      { threadId: 'other' },
      { userDescription: 'old' },
      { context: { recentMessages: [], errorLogs: 'different' } },
      { signalDetail: { reasonCode: 'old' } },
    ]) {
      assert.deepEqual(
        await f.other.compareAndSetCommunityIssueDraft({ ...f.input, expectedSource: { ...f.source, ...delta } }),
        { outcome: 'stale_source' },
      );
    }
    assert.equal(await f.peer.hget(f.key, 'communityIssueDraftId'), 'D1');
  });
  test('replacement needs exact previous link and Host replacement authority', async (t) => {
    const f = await fixture(t);
    await f.store.compareAndSetCommunityIssueDraft(f.input);
    const replacement = { ...f.input, draftId: 'D2', expectedDraftId: 'D1' };
    assert.deepEqual(await f.other.compareAndSetCommunityIssueDraft(replacement), { outcome: 'conflict' });
    assert.deepEqual(
      await f.other.compareAndSetCommunityIssueDraft({ ...replacement, allowReplace: true, expectedDraftId: 'wrong' }),
      { outcome: 'conflict' },
    );
    assert.deepEqual(await f.other.compareAndSetCommunityIssueDraft({ ...replacement, allowReplace: true }), {
      outcome: 'linked',
    });
    assert.equal(await f.redis.hget(f.key, 'communityIssueDraftId'), 'D2');
  });
  test('independent simultaneous writers produce one winner without overwriting source history', async (t) => {
    const f = await fixture(t);
    const results = await Promise.all([
      f.store.compareAndSetCommunityIssueDraft(f.input),
      f.other.compareAndSetCommunityIssueDraft({ ...f.input, draftId: 'D2' }),
    ]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['conflict', 'linked']);
    const saved = await f.other.getById(f.source.issueId);
    assert.deepEqual(saved.context, f.source.context);
    assert.equal(saved.userDescription, f.source.userDescription);
  });
  test('material mutation between read and Lua blocks even a same-link replay', async (t) => {
    const f = await fixture(t);
    await f.store.compareAndSetCommunityIssueDraft(f.input);
    f.afterRead(() => f.peer.hset(f.key, 'userDescription', 'changed'));
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(f.input), { outcome: 'stale_source' });
    assert.equal(await f.peer.hget(f.key, 'communityIssueDraftId'), 'D1');
  });
  test('status and ownership races are rejected by the atomic write', async (t) => {
    const f = await fixture(t);
    f.afterRead(() => f.peer.hset(f.key, 'userId', 'other'));
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(f.input), { outcome: 'stale_source' });
    await f.peer.hset(f.key, 'userId', 'owner');
    f.afterRead(() => f.peer.hset(f.key, 'status', 'skipped'));
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(f.input), { outcome: 'not_confirmed' });
    assert.equal(await f.peer.hget(f.key, 'communityIssueDraftId'), null);
  });
  test('card visibility mutation between read and Lua neither conflicts nor gets overwritten', async (t) => {
    const f = await fixture(t);
    f.afterRead(() => f.peer.hset(f.key, 'cardMessageId', 'card'));
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(f.input), { outcome: 'linked' });
    assert.equal(await f.peer.hget(f.key, 'cardMessageId'), 'card');
  });
  test('caller cannot change captured authority or draft while the store awaits Redis', async (t) => {
    const f = await fixture(t);
    await f.store.compareAndSetCommunityIssueDraft(f.input);
    const replacement = { ...f.input, expectedDraftId: 'D1', draftId: 'D2' };
    f.afterRead(async () => {
      replacement.allowReplace = true;
      replacement.draftId = 'injected';
    });
    assert.deepEqual(await f.store.compareAndSetCommunityIssueDraft(replacement), { outcome: 'conflict' });
    assert.equal(await f.peer.hget(f.key, 'communityIssueDraftId'), 'D1');
  });
});
