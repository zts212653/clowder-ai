import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { type McpContribution, validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { currentPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { NativePluginActions } from '../src/domains/plugin/declared/native-plugin-actions.js';
import { pluginNativeActionRoutes } from '../src/routes/plugin-native-action-routes.js';

test('native route authenticates separately, captures optional source, and refuses stale/foreign calls', async () => {
  const logs: Record<string, unknown>[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs.push(JSON.parse(chunk.toString()));
          done();
        },
      }),
    },
  });
  let current = true;
  let latestCurrent = true;
  let sourceExists = true;
  let deleted = false;
  let writes = 0;
  const record = {
    invocationId: 'inv',
    callbackToken: 'secret',
    catId: 'codex',
    threadId: 'thread',
    userId: 'owner',
    originTriggerMessageId: 'message',
  };
  const verify = async (id: string, token: string) =>
    current && id === 'inv' && token === 'secret'
      ? { ok: true as const, record }
      : { ok: false as const, reason: 'invalid_token' as const };
  const authority = {
    instance: {
      pluginInstanceId: 'plugin-instance',
      pluginId: 'fixture',
      packageDigest: 'digest',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      manifest: {
        pluginId: 'fixture',
        version: '1.0.0',
        contractVersion: '0.1.0',
        runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
        name: 'Native route fixture',
        features: [
          {
            id: 'main',
            name: 'Main',
            resources: [],
            capabilities: [],
            contributions: [{ type: 'mcp', id: 'example' }],
          },
        ],
        contributions: [
          {
            type: 'mcp',
            id: 'example',
            runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
            actions: [{ method: 'example.run' }],
          } satisfies McpContribution,
        ],
      },
    },
    effectiveGrants: [],
  };
  const validation = validateManifest(authority.packageRecord.manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const actions = new NativePluginActions(async () => authority as never);
  actions.activate(authority as never, 0, async (_method, input) => {
    writes++;
    const context = currentPluginCallContext('plugin-instance')!;
    return {
      input,
      identity: { catId: context.catId, threadId: context.threadId, userId: context.userId, source: context.source },
    };
  });
  await app.register(pluginNativeActionRoutes, {
    actions,
    registry: {
      verify,
      verifyLatest: async (id: string, token: string) =>
        latestCurrent ? verify(id, token) : { ok: false, reason: 'stale_invocation' },
      isStartupRecoveryComplete: () => true,
    } as never,
    sources: {
      invocationTracker: {
        getActiveSlots: () => [
          {
            catId: 'codex',
            activeRun: { invocationId: 'inv', threadId: 'thread', targetId: 'codex', inputMessageIds: ['message'] },
          },
        ],
      } as never,
      messageStore: {
        getById: async () => (sourceExists ? { id: 'message', threadId: 'thread', userId: 'owner' } : null),
      } as never,
    },
    threadStore: { get: async () => ({ deletedAt: deleted ? 1 : undefined }) },
  });
  const request = {
    method: 'POST' as const,
    url: '/api/plugin-runtime/action',
    headers: {
      'x-invocation-id': 'inv',
      'x-callback-token': 'secret',
      'x-clowder-plugin-action-token': actions.environment('plugin-instance', 'example').CLOWDER_PLUGIN_ACTION_TOKEN!,
    },
    payload: { method: 'example.run', input: { catId: 'spoof' } },
  };
  try {
    assert.equal((await app.inject({ ...request, headers: {} })).statusCode, 401);
    assert.equal(
      (await app.inject({ ...request, headers: { ...request.headers, 'x-clowder-plugin-action-token': 'foreign' } }))
        .statusCode,
      401,
    );
    const response = await app.inject(request);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().result.identity, {
      catId: 'codex',
      threadId: 'thread',
      userId: 'owner',
      source: { kind: 'primary', sourceMessageId: 'message' },
    });
    assert.equal(response.json().result.input.catId, 'spoof');
    assert.equal(response.body.includes('secret'), false);
    assert.equal(writes, 1);
    sourceExists = false;
    const withoutSource = await app.inject(request);
    assert.equal(withoutSource.statusCode, 200);
    assert.equal(withoutSource.json().result.identity.source, undefined);
    assert.equal(
      (await app.inject({ ...request, payload: { ...request.payload, context: { catId: 'spoof' } } })).statusCode,
      400,
    );
    assert.equal((await app.inject({ ...request, payload: { method: 'not.declared', input: {} } })).statusCode, 403);
    deleted = true;
    assert.equal((await app.inject(request)).statusCode, 410);
    deleted = false;
    latestCurrent = false;
    assert.equal((await app.inject(request)).statusCode, 401);
    latestCurrent = true;
    current = false;
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal(writes, 2);
    const diagnostics = logs.filter((row) => row.event === 'plugin_native_auth');
    assert.ok(diagnostics.some((row) => row.stage === 'headers' && row.reason === 'missing_credentials'));
    assert.ok(diagnostics.some((row) => row.stage === 'callback_prehandler' && row.reason === 'invalid_token'));
    assert.ok(diagnostics.some((row) => row.stage === 'invocation_currentness' && row.reason === 'stale_invocation'));
    assert.ok(diagnostics.some((row) => row.stage === 'activation' && row.reason === 'inactive_connection'));
    assert.ok(diagnostics.some((row) => row.stage === 'completed'));
    assert.ok(diagnostics.every((row) => typeof row.reqId === 'string'));
    const encoded = JSON.stringify(diagnostics);
    assert.equal(encoded.includes(request.headers['x-callback-token']), false);
    assert.equal(encoded.includes(request.headers['x-clowder-plugin-action-token']), false);
    assert.equal(encoded.includes('spoof'), false);
  } finally {
    await app.close();
  }
});
