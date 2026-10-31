import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import type { DotReturnService } from '../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import { registerDotMcpRoutes } from '../src/routes/chatgpt-dot-mcp-routes.js';

test('subscription diagnostics identify DNS rejection without recording callback or pairing secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-diagnostics-'));
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream } });
  let failure = new Error('URL resolves to private/reserved IP range: 198.18.0.1');
  try {
    const keys = new AgentKeyRegistry();
    const connection = new DotConnectionService({
      keys,
      store: new DotConnectionStore(join(directory, 'connection.json')),
      authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'dot-instance' }),
      ensureIdentity: async () => {},
      sendWebhook: async () => {
        throw failure;
      },
    });
    const setup = await connection.begin('owner');
    assert.ok(setup.pairingCode);
    const pro = await keys.issue(createCatId('gpt-pro'), 'owner');
    registerDotMcpRoutes(app, {
      connection,
      returns: {} as DotReturnService,
      publishImage: async () => {},
    });
    const callbackSecret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
    const opaquePath = 'private-callback-coordinate';
    const request = {
      method: 'POST' as const,
      url: '/api/plugins/chatgpt-dot/shared-mcp',
      headers: { 'x-agent-key-secret': pro.secret },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'events/subscribe',
        params: {
          name: 'dot.summoned',
          arguments: { attempt_id: setup.attemptId, pairing_code: setup.pairingCode },
          delivery: {
            mode: 'webhook',
            url: `https://callback.example.test/${opaquePath}?token=private-query-coordinate`,
            secret: callbackSecret,
          },
        },
      },
    };
    const response = await app.inject(request);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().error.data.reason, 'dot_operation_unavailable', 'wire compatibility is preserved');
    const records: Array<Record<string, unknown>> = logs
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const received = records.find((record) => record.msg === 'dot_subscription_received');
    assert.equal(received?.dotMethod, 'events/subscribe');
    assert.equal(received?.callbackHostname, 'callback.example.test');
    const failed = records.find((record) => record.msg === 'dot_subscription_failed');
    assert.equal(failed?.dotFailureReason, 'callback_non_public_address');
    assert.equal(failed?.reqId, received?.reqId);
    for (const hidden of [
      setup.pairingCode,
      setup.credentialSecret,
      pro.secret,
      callbackSecret,
      opaquePath,
      'private-query-coordinate',
    ])
      assert.equal(logs.includes(hidden), false);
    assert.equal((await connection.status()).paired, false);
    assert.equal((await connection.status()).subscription, 'absent');
    logs = '';
    failure = Object.assign(new Error(`getaddrinfo ENOTFOUND callback.example.test/${opaquePath}`), {
      code: 'ENOTFOUND',
    });
    assert.equal((await app.inject(request)).json().error.data.reason, 'dot_operation_unavailable');
    const networkFailure = logs
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.msg === 'dot_subscription_failed');
    assert.equal(networkFailure?.dotFailureCode, 'ENOTFOUND');
    assert.equal(logs.includes(opaquePath), false);
    logs = '';
    failure = Object.assign(new Error('unclassified transport failure'), { code: `${opaquePath}/secret` });
    await app.inject(request);
    assert.equal(logs.includes('dotFailureCode'), false);
    assert.equal(logs.includes(opaquePath), false);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
