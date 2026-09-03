import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CloudReturnGrantRetentionMs,
  MemoryCloudReturnGrantStore,
  RedisCloudReturnGrantStore,
} from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';

const claims = {
  threadId: 'thread-f247',
  userId: 'alice',
  sourceMessageId: 'source-f247',
  dispatchInvocationId: 'dispatch-f247',
  targetCatId: 'gpt-pro',
};
const scope = {
  threadId: claims.threadId,
  userId: claims.userId,
  sourceMessageId: claims.sourceMessageId,
  targetCatId: claims.targetCatId,
};

describe('F247 server-custodied grant retention', () => {
  it('bounds Redis retention on issue, existing-record repair, and commit', async () => {
    const values = new Map();
    const setCalls = [];
    const evalCalls = [];
    const redis = {
      async set(key, value, ...args) {
        setCalls.push([key, value, ...args]);
        if (args.includes('NX') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
      async get(key) {
        return values.get(key) ?? null;
      },
      async eval(...args) {
        evalCalls.push(args);
        return 1;
      },
    };
    const store = new RedisCloudReturnGrantStore(redis);

    assert.deepEqual(await store.issue(claims), { ok: true, status: 'issued' });
    assert.deepEqual(setCalls[0].slice(2), ['PX', CloudReturnGrantRetentionMs, 'NX']);
    assert.deepEqual(await store.issue(claims), { ok: true, status: 'existing' });
    assert.equal(evalCalls[0].at(-1), CloudReturnGrantRetentionMs);

    const claim = await store.claim(scope);
    assert.equal(claim.ok, true);
    assert.equal(await store.commit(claim), true);
    assert.equal(evalCalls.at(-1).at(-1), CloudReturnGrantRetentionMs);
  });

  it('expires pending and consumed grants in the in-memory parity store', async () => {
    let now = 10_000;
    const store = new MemoryCloudReturnGrantStore(() => now);
    await store.issue(claims);
    now += CloudReturnGrantRetentionMs + 1;
    assert.deepEqual(await store.claim(scope), { ok: false, reason: 'not_found' });

    await store.issue(claims);
    const claim = await store.claim(scope);
    assert.equal(claim.ok, true);
    assert.equal(await store.commit(claim), true);
    assert.deepEqual(await store.claim(scope), { ok: false, reason: 'consumed' });
    now += CloudReturnGrantRetentionMs + 1;
    assert.deepEqual(await store.claim(scope), { ok: false, reason: 'not_found' });
  });

  it('refreshes retention when reissuing an existing in-memory grant', async () => {
    let now = 10_000;
    const store = new MemoryCloudReturnGrantStore(() => now);
    assert.deepEqual(await store.issue(claims), { ok: true, status: 'issued' });

    now += CloudReturnGrantRetentionMs - 1;
    assert.deepEqual(await store.issue(claims), { ok: true, status: 'existing' });

    now += 2;
    const claim = await store.claim(scope);
    assert.equal(claim.ok, true);
  });

  it('fails issuance when an existing Redis grant expires before its retention refresh', async () => {
    const redis = {
      async set() {
        return null;
      },
      async eval() {
        return 0;
      },
    };
    const store = new RedisCloudReturnGrantStore(redis);

    assert.deepEqual(await store.issue(claims), { ok: false, reason: 'scope_collision' });
  });
});
