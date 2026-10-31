import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import type { DotReturnService } from '../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import { registerDotMcpRoutes } from '../src/routes/chatgpt-dot-mcp-routes.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-event-params-'));
  let logs = '';
  let challenges = 0;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream } });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const keys = new AgentKeyRegistry();
  const connection = new DotConnectionService({
    keys,
    store: new DotConnectionStore(join(directory, 'connection.json')),
    authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'dot-instance' }),
    ensureIdentity: async () => {},
    sendWebhook: async (_url, _headers, body) => {
      challenges++;
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    },
  });
  const setup = await connection.begin('owner');
  const pro = await keys.issue(createCatId('gpt-pro'), 'owner');
  registerDotMcpRoutes(app, { connection, returns: {} as DotReturnService, publishImage: async () => {} });
  const callbackSecret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  const params = {
    name: 'dot.summoned',
    arguments: { attempt_id: setup.attemptId, pairing_code: setup.pairingCode },
    delivery: {
      mode: 'webhook',
      url: 'https://callback.example.test/private-path?token=private-query',
      secret: callbackSecret,
    },
    cursor: null,
  };
  const rpc = (method: string, input: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/plugins/chatgpt-dot/shared-mcp',
      headers: { 'x-agent-key-secret': pro.secret },
      payload: { jsonrpc: '2.0', id: 1, method, params: input },
    });
  return {
    connection,
    params,
    rpc,
    setup,
    pro,
    callbackSecret,
    corruptState: () => writeFile(join(directory, 'connection.json'), '{}'),
    logs: () => logs,
    challenges: () => challenges,
    records: () =>
      logs
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const metadata = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'example.com/ownerUserId': 'not-the-owner',
};

for (const extension of [{ _meta: metadata }, { maxAgeMs: 300000 }, { _meta: metadata, maxAgeMs: 0 }]) {
  test(`valid Events request extensions reach verification: ${Object.keys(extension).join(',')}`, async (t) => {
    const f = await fixture(t);
    const response = await f.rpc('events/subscribe', { ...f.params, ...extension });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().error, undefined, 'legal protocol extensions must not fail parameter validation');
    assert.equal(response.json().result.resultType, 'complete');
    assert.equal(f.challenges(), 1);
    const state = await f.connection.current();
    assert.equal(state?.ownerUserId, 'owner', 'metadata must not select the authenticated owner');
    assert.equal(state?.pairedAt !== null, true);
    assert.equal(state?.subscription?.id, response.json().result.id);
    const repeated = await f.rpc('events/subscribe', { ...f.params, ...extension });
    assert.equal(repeated.json().result.id, response.json().result.id);
    assert.equal(f.challenges(), 1, 'retries retain bounded verification caching');
    const { secret: _secret, ...delivery } = f.params.delivery;
    const stopped = await f.rpc('events/unsubscribe', {
      name: f.params.name,
      arguments: f.params.arguments,
      delivery,
      _meta: metadata,
    });
    assert.equal(stopped.json().error, undefined);
    assert.equal((await f.connection.current())?.subscription, null);
  });
}

test('invalid subscription diagnostics expose only schema paths, types and known extension names', async (t) => {
  const f = await fixture(t);
  const unknownKey = 'never-log-unknown-key';
  const response = await f.rpc('events/subscribe', {
    ...f.params,
    _meta: 'private-metadata-value',
    maxAgeMs: 'private-age-value',
    requestState: 'private-state-value',
    inputResponses: { secret: 'private-input-response' },
    [unknownKey]: 'private-unknown-value',
    arguments: { ...f.params.arguments, 'private-argument-key': 'private-argument-value' },
  });
  assert.deepEqual(response.json().error, { code: -32602, message: 'Invalid parameters' });
  assert.equal(f.challenges(), 0);
  assert.equal((await f.connection.current())?.subscription, null);
  const failed = f.records().find((r) => r.msg === 'dot_subscription_failed');
  assert.equal(failed?.dotPhase, 'subscription_parse');
  const issues = failed?.dotValidationIssues as Array<Record<string, unknown>>;
  assert.ok(issues.some((i) => i.path === '_meta' && i.code === 'invalid_type' && i.expected === 'object'));
  assert.ok(issues.some((i) => i.path === 'maxAgeMs' && i.code === 'invalid_type' && i.expected === 'number'));
  assert.ok(
    issues.some(
      (i) => i.path === '' && JSON.stringify(i.keys) === '["inputResponses","requestState"]' && i.unknownKeyCount === 1,
    ),
  );
  for (const value of [
    unknownKey,
    'private-metadata-value',
    'private-age-value',
    'private-state-value',
    'private-input-response',
    'private-unknown-value',
    'private-argument-key',
    'private-argument-value',
    f.setup.pairingCode,
    f.setup.credentialSecret,
    f.pro.secret,
    f.callbackSecret,
    'private-path',
    'private-query',
  ]) {
    assert.equal(f.logs().includes(value), false, 'diagnostics must not record values or arbitrary keys');
  }
  assert.equal(
    f.records().some((r) => r.msg === 'dot_subscription_received'),
    false,
  );
});

test('protocol extensions do not relax delivery, argument or replay-bound validation', async (t) => {
  const f = await fixture(t);
  for (const input of [
    { ...f.params, _meta: metadata, maxAgeMs: -1 },
    { ...f.params, _meta: metadata, maxAgeMs: 1.5 },
    { ...f.params, _meta: metadata, delivery: { ...f.params.delivery, headers: {} } },
    { ...f.params, _meta: metadata, arguments: { ...f.params.arguments, ownerUserId: 'other' } },
  ])
    assert.equal((await f.rpc('events/subscribe', input)).json().error.code, -32602);
  assert.equal(f.challenges(), 0);
  assert.equal((await f.connection.current())?.subscription, null);
});

test('invalid stored connection is distinguished from a rejected request schema', async (t) => {
  const f = await fixture(t);
  await f.corruptState();
  assert.equal((await f.rpc('events/subscribe', f.params)).json().error.code, -32602);
  const failed = f.records().find((r) => r.msg === 'dot_subscription_failed');
  assert.equal(failed?.dotPhase, 'connection_or_service');
  assert.equal(failed?.dotValidationIssues, undefined);
  assert.equal(f.challenges(), 0);
});

test('schema diagnostics remain bounded for a request with many invalid fields', async (t) => {
  const f = await fixture(t);
  await f.rpc('events/subscribe', {
    name: 123,
    arguments: { attempt_id: 123, pairing_code: 123 },
    delivery: { mode: 123, url: 123, secret: 123 },
    _meta: 123,
    cursor: 123,
    ttlMs: -1,
    maxAgeMs: -1,
    'arbitrary-key-never-logged': 'arbitrary-value-never-logged',
  });
  const failed = f.records().find((r) => r.msg === 'dot_subscription_failed');
  assert.ok((failed?.dotValidationIssueCount as number) > 8);
  assert.equal((failed?.dotValidationIssues as unknown[]).length, 8);
  assert.equal(f.logs().includes('arbitrary-key-never-logged'), false);
  assert.equal(f.logs().includes('arbitrary-value-never-logged'), false);
  assert.equal(f.challenges(), 0);
});
