import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OfficialPluginHistoryImportError } from '../dist/domains/plugin/index.js';
import { harness, writeHeaders } from './plugin-official-routes.fixture.js';

const reference = 'https://my.feishu.cn/minutes/obcne9c5d9z4l3o3nk9mg777';

async function runningHarness(overrides = {}) {
  const calls = [];
  const historyImport = overrides.historyImport ?? {
    importMinute: async (input) => {
      if (input.reference.startsWith('/')) {
        throw new OfficialPluginHistoryImportError(
          'INVALID_REFERENCE',
          'Feishu Minutes reference must be a token or HTTPS Minutes URL',
        );
      }
      calls.push(input);
      return { publicationId: 'pub_history', disposition: 'accepted' };
    },
  };
  const result = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('auth start is not expected');
      },
    },
    historyImport,
  });
  await result.store.transaction((transaction) => {
    const instance = transaction.instances.get('pi_official');
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
      lifecycleRevision: 7,
    });
  });
  return { ...result, calls };
}

test('owner imports one historical Minute through the current official instance fence', async () => {
  const { app, calls } = await runningHarness();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/history-import',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 7, reference },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json(), { publicationId: 'pub_history', disposition: 'accepted' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].instance.pluginInstanceId, 'pi_official');
    assert.equal(calls[0].entry.catalogId, 'feishu-meeting-intake');
    assert.equal(calls[0].expectedRevision, 7);
    assert.equal(calls[0].reference, reference);
  } finally {
    await app.close();
  }
});

test('historical import is owner-only, localhost-only, and rejects ambiguous bodies', async () => {
  const { app, calls } = await runningHarness();
  try {
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/history-import',
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 7, reference },
    });
    assert.equal(noSession.statusCode, 401);

    const remote = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/history-import',
      headers: writeHeaders,
      remoteAddress: '203.0.113.10',
      payload: { expectedRevision: 7, reference },
    });
    assert.equal(remote.statusCode, 403);

    for (const payload of [
      { expectedRevision: 7, reference, path: '/tmp/transcript.txt' },
      { expectedRevision: 7, reference: '/tmp/transcript.txt' },
      { expectedRevision: 0, reference },
    ]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/plugins/official/pi_official/history-import',
        headers: writeHeaders,
        remoteAddress: '127.0.0.1',
        payload,
      });
      assert.equal(invalid.statusCode, 400, invalid.payload);
    }
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test('historical import fail-closes when auth or runtime authority is not current', async () => {
  const disconnected = await harness({
    auth: {
      status: async () => ({ status: 'not_connected' }),
      start: async () => {
        throw new Error('auth start is not expected');
      },
    },
    historyImport: { importMinute: async () => assert.fail('import must not run') },
  });
  try {
    await disconnected.store.transaction((transaction) => {
      const instance = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...instance,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
      });
    });
    const response = await disconnected.app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/history-import',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1, reference },
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().code, 'AUTH_REQUIRED');
  } finally {
    await disconnected.app.close();
  }

  const stopped = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('auth start is not expected');
      },
    },
    historyImport: { importMinute: async () => assert.fail('import must not run') },
  });
  try {
    const response = await stopped.app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/history-import',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1, reference },
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().code, 'INSTANCE_NOT_READY');
  } finally {
    await stopped.app.close();
  }
});
