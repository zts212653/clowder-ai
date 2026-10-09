import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { copyLegacyGitHubState } from '../scripts/f202-legacy-github-copy.mjs';

async function fixture(plan, values) {
  const app = Fastify();
  const reads = [],
    calls = [];
  const redis = {
    multi() {
      const keys = [];
      return {
        hgetall(key) {
          keys.push(key);
          return this;
        },
        get(key) {
          keys.push(key);
          return this;
        },
        async exec() {
          reads.push(keys);
          return keys.map((key) => [null, values[key] ?? null]);
        },
      };
    },
  };
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = request.headers['x-test-session'];
  });
  app.post('/copy', async (request, reply) => {
    const result = await copyLegacyGitHubState({
      request,
      redis,
      plan,
      operations: {
        async runAction(...args) {
          calls.push(JSON.parse(JSON.stringify(args)));
          return { status: 200, body: { ok: true } };
        },
      },
    });
    return reply.code(result.status).send(result.body);
  });
  return {
    app,
    reads,
    calls,
    headers: {
      host: 'localhost:4999',
      origin: 'http://localhost:4999',
      'x-test-session': process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner',
    },
  };
}

test('copy refuses untrusted identity, remote origin and missing confirmation before reading old state', async (t) => {
  const f = await fixture({ kind: 'issues', ids: ['one'] }, {});
  t.after(() => f.app.close());
  for (const [headers, payload] of [
    [
      { host: 'localhost:4999', origin: 'http://localhost:4999' },
      { confirmed: true, userId: 'owner' },
    ],
    [{ ...f.headers, origin: 'https://example.com' }, { confirmed: true }],
    [f.headers, {}],
  ]) {
    assert.notEqual((await f.app.inject({ method: 'POST', url: '/copy', headers, payload })).statusCode, 200);
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.calls, []);
});

test('raw export preserves field presence and strings, fixes its target, and does not trust payload source keys', async (t) => {
  const raw = { z: '{"not":"decoded"}', title: '测试', a: '[]' };
  const f = await fixture({ kind: 'issues', ids: ['one'] }, { 'community-issue:one': raw });
  t.after(() => f.app.close());
  const response = await f.app.inject({
    method: 'POST',
    url: '/copy',
    headers: f.headers,
    payload: { confirmed: true, plan: { kind: 'issues', ids: ['secret'] }, pluginId: 'foreign' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(f.reads, [['community-issue:one']]);
  const bytes = '{"issues":{"one":{"a":"[]","title":"测试","z":"{\\"not\\":\\"decoded\\"}"}}}';
  assert.deepEqual(f.calls, [
    [
      'official.github-operations',
      'legacyIssueObservations',
      'import',
      {
        protocolVersion: 1,
        sourceDigest: createHash('sha256').update(bytes).digest('hex'),
        snapshot: { issues: { one: raw } },
      },
    ],
  ]);
});

test('repository export preserves absence; foreign key, duplicate, count and byte limits fail before invocation', async (t) => {
  const repo = 'example/project',
    key = `f141:baseline:${repo}`,
    cursor = `community:repo-comment:cursor:${repo}`;
  const f = await fixture({ kind: 'repositories', records: { [repo]: [key, cursor] } }, { [key]: '1' });
  t.after(() => f.app.close());
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/copy', headers: f.headers, payload: { confirmed: true } })).statusCode,
    200,
  );
  assert.deepEqual(f.calls[0][3].snapshot, { repositories: { [repo]: { [key]: '1' } } });
  for (const plan of [
    { kind: 'repositories', records: { [repo]: ['secret:token'] } },
    { kind: 'repositories', records: { [repo]: [key, key] } },
    { kind: 'issues', ids: Array.from({ length: 501 }, (_, i) => String(i)) },
  ]) {
    const bad = await fixture(plan, {});
    t.after(() => bad.app.close());
    assert.equal(
      (await bad.app.inject({ method: 'POST', url: '/copy', headers: bad.headers, payload: { confirmed: true } }))
        .statusCode,
      500,
    );
    assert.deepEqual(bad.reads, []);
    assert.deepEqual(bad.calls, []);
  }
  const huge = await fixture(
    { kind: 'issues', ids: ['one'] },
    { 'community-issue:one': { title: 'x'.repeat(256 * 1024) } },
  );
  t.after(() => huge.app.close());
  assert.equal(
    (await huge.app.inject({ method: 'POST', url: '/copy', headers: huge.headers, payload: { confirmed: true } }))
      .statusCode,
    413,
  );
  assert.deepEqual(huge.calls, []);
});
