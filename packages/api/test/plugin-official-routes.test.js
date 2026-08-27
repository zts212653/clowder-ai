import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entry, harness, installPayload, readHeaders, writeHeaders } from './plugin-official-routes.fixture.js';

test('pins the runnable alpha.8 artifact and activates its package-owned owner auth contract', () => {
  assert.equal(entry.version, '0.1.0-alpha.8');
  assert.equal(
    entry.archiveUrl,
    'https://registry.npmjs.org/@clowder-ai/feishu-meeting-intake/-/feishu-meeting-intake-0.1.0-alpha.8.tgz',
  );
  assert.equal(
    entry.packageDigest,
    'sha512-unl8sq1rEMckgiqE8mI0e0+Qa6l69J4cxT2GOe5AMUSomkrbmpKdZR/EYljvH+hP4tNaR9l1KQd6T9GWX49L4w==',
  );
  assert.deepEqual(entry.ownerAuth, {
    kind: 'lark-cli-device',
    runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
    domains: ['event', 'minutes', 'note', 'vc'],
  });
});

test('projects exact official catalog and durable installed state only to authenticated sessions', async () => {
  const { app, store } = await harness();
  try {
    await store.transaction((transaction) => {
      const instance = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...instance,
        lastRuntimeError: {
          code: 'EVENT_BUS_CONFLICT',
          exitCode: 17,
          signal: null,
          occurredAt: 1_234,
        },
      });
    });
    assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/official' })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.equal(body.plugins[0].catalogId, 'feishu-meeting-intake');
    assert.equal(body.plugins[0].version, '0.1.0-alpha.8');
    assert.equal(body.plugins[0].availableVersion, '0.1.0-alpha.8');
    assert.equal(body.plugins[0].packageDigest, entry.packageDigest);
    assert.equal(body.plugins[0].updateAvailable, false);
    assert.equal(body.plugins[0].ownerAuthAvailable, true);
    assert.equal(body.plugins[0].instance.lifecycleRevision, 1);
    assert.equal(body.plugins[0].instance.installedVersion, '0.1.0-alpha.8');
    assert.equal(body.plugins[0].instance.packageDigest, entry.packageDigest);
    assert.equal(body.plugins[0].instance.runtimeState, 'stopped');
    assert.deepEqual(body.plugins[0].instance.lastRuntimeError, {
      code: 'EVENT_BUS_CONFLICT',
      exitCode: 17,
      signal: null,
      occurredAt: 1_234,
    });
  } finally {
    await app.close();
  }
});

test('projects package-owned observation health and a visible stale recovery action', async () => {
  const intakeHealth = {
    status: 'degraded',
    code: 'OBSERVATION_STALE',
    lastCycleAt: 1_000,
    lastSuccessfulObservationAt: 1_000,
    lastPublishedAt: null,
    pendingCount: 0,
    catchUp: { status: 'idle' },
    warning: {
      code: 'OBSERVATION_STALE',
      message: '飞书已超过 2 分钟没有成功观测',
      action: 'preview-catch-up',
    },
  };
  const { app } = await harness({
    meetingIntake: {
      project: async () => intakeHealth,
      detect: async () => ({ status: 'idle' }),
      preview: async () => {
        throw new Error('not used');
      },
      resolve: async () => {
        throw new Error('not used');
      },
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json().plugins[0].intakeHealth, intakeHealth);
  } finally {
    await app.close();
  }
});

test('blocks activation when the package detects an owner catch-up decision window', async () => {
  const { app, processCalls } = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('not used');
      },
    },
    meetingIntake: {
      project: async () => undefined,
      detect: async () => ({
        status: 'needs-owner',
        fromCursor: 'poll-v1:1000',
        throughCursor: 'poll-v1:5000',
        detectedAt: 5_200,
      }),
      preview: async () => {
        throw new Error('not used');
      },
      resolve: async () => {
        throw new Error('not used');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().code, 'CATCH_UP_REQUIRED');
    assert.deepEqual(processCalls, []);
  } finally {
    await app.close();
  }
});

test('previews the frozen catch-up window while a disabled runtime remains stopped', async () => {
  const previewCalls = [];
  const { app, processCalls } = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('not used');
      },
    },
    meetingIntake: {
      project: async () => undefined,
      detect: async () => ({ status: 'idle' }),
      preview: async (_entry, instance) => {
        previewCalls.push(instance);
        return {
          fromCursor: 'poll-v1:1000',
          throughCursor: 'poll-v1:5000',
          candidateCount: 3,
          fingerprint: 'a'.repeat(64),
        };
      },
      resolve: async () => {
        throw new Error('not used');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/catch-up/preview',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().preview.candidateCount, 3);
    assert.equal(previewCalls[0].runtimeState, 'stopped');
    assert.deepEqual(processCalls, []);
  } finally {
    await app.close();
  }
});

test('requires the recovery-capable package update before inspecting an older live state file', async () => {
  let previews = 0;
  const { app, processCalls } = await harness({
    installedVersion: '0.1.0-alpha.7',
    installedDigest: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('not used');
      },
    },
    meetingIntake: {
      project: async () => undefined,
      detect: async () => ({ status: 'needs-owner' }),
      preview: async () => {
        previews += 1;
        throw new Error('must update first');
      },
      resolve: async () => {
        throw new Error('not used');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/catch-up/preview',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().code, 'UPDATE_REQUIRED');
    assert.equal(previews, 0);
    assert.deepEqual(processCalls, []);
  } finally {
    await app.close();
  }
});

test('an explicit future-only decision resolves the gap and starts only future intake', async () => {
  const resolutionCalls = [];
  const { app, store, processCalls } = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('not used');
      },
    },
    meetingIntake: {
      project: async () => undefined,
      detect: async () => ({ status: 'idle' }),
      preview: async () => {
        throw new Error('not used');
      },
      resolve: async (_entry, instance, decision) => {
        resolutionCalls.push({ instance, decision });
        return { action: decision.action, candidateCount: 3 };
      },
    },
  });
  try {
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_official');
      transaction.instances.put({ ...current, configReadiness: 'ready' });
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/catch-up/resolve',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        fingerprint: 'a'.repeat(64),
        action: 'future-only',
        resume: true,
      },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().resolution.action, 'future-only');
    assert.equal(response.json().plugin.instance.activationState, 'enabled');
    assert.equal(resolutionCalls[0].decision.fingerprint, 'a'.repeat(64));
    assert.deepEqual(processCalls, ['start:pi_official']);
  } finally {
    await app.close();
  }
});

test('an enabled intent cannot bypass owner auth by resolving with resume=false', async () => {
  let resolutions = 0;
  const { app, store, processCalls } = await harness({
    auth: {
      status: async () => ({ status: 'not_connected' }),
      start: async () => {
        throw new Error('not used');
      },
    },
    meetingIntake: {
      project: async () => undefined,
      detect: async () => ({ status: 'idle' }),
      preview: async () => {
        throw new Error('not used');
      },
      resolve: async () => {
        resolutions += 1;
        return { action: 'future-only', candidateCount: 3 };
      },
    },
  });
  try {
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
      });
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/catch-up/resolve',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        fingerprint: 'a'.repeat(64),
        action: 'future-only',
        resume: false,
      },
    });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().code, 'AUTH_REQUIRED');
    assert.equal(resolutions, 0);
    assert.deepEqual(processCalls, []);
  } finally {
    await app.close();
  }
});

test('a resolved catch-up window resumes directly from an actionable maintenance error', async () => {
  const { app, store, processCalls } = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('not used');
      },
    },
    meetingIntake: {
      project: async () => undefined,
      detect: async () => ({ status: 'idle' }),
      preview: async () => {
        throw new Error('not used');
      },
      resolve: async (_entry, _instance, decision) => ({ action: decision.action, candidateCount: 3 }),
    },
  });
  try {
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'error',
        runtimeState: 'stopped',
        lastRuntimeError: {
          code: 'UPDATE_RESUME_FAILED',
          exitCode: null,
          signal: null,
          occurredAt: 5_100,
        },
      });
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/catch-up/resolve',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        fingerprint: 'a'.repeat(64),
        action: 'replay',
        resume: true,
      },
    });

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().plugin.instance.activationState, 'enabled');
    assert.deepEqual(processCalls, ['start:pi_official']);
  } finally {
    await app.close();
  }
});

test('projects installed versus available truth and keeps a disabled owner intent disabled', async () => {
  const oldDigest = 'sha512-pLYTYEdGdAXrWBlKrLcUtrTJ6mszT6dmHpBDFOFLuPh1qkJAqwQ+S/xT/ORvjislG6jAgrzmYWnzlZMa778iEA==';
  const { app, processCalls, updateCalls } = await harness({
    installedVersion: '0.1.0-alpha.2',
    installedDigest: oldDigest,
  });
  try {
    const before = await app.inject({ method: 'GET', url: '/api/plugins/official', headers: readHeaders });
    assert.equal(before.statusCode, 200, before.payload);
    assert.equal(before.json().plugins[0].availableVersion, '0.1.0-alpha.8');
    assert.equal(before.json().plugins[0].updateAvailable, true);
    assert.equal(before.json().plugins[0].instance.installedVersion, '0.1.0-alpha.2');
    assert.equal(before.json().plugins[0].instance.packageDigest, oldDigest);

    const updated = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/update',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        expectedCatalogVersion: entry.version,
        expectedPackageDigest: entry.packageDigest,
      },
    });
    assert.equal(updated.statusCode, 200, updated.payload);
    assert.deepEqual(updateCalls, [
      {
        catalogId: 'feishu-meeting-intake',
        instanceId: 'pi_official',
        expectedRevision: 1,
        expectedRelease: { version: entry.version, packageDigest: entry.packageDigest },
      },
    ]);
    assert.equal(updated.json().updateAvailable, false);
    assert.equal(updated.json().instance.installedVersion, '0.1.0-alpha.8');
    assert.equal(updated.json().instance.packageDigest, entry.packageDigest);
    assert.equal(updated.json().instance.activationState, 'disabled');
    assert.equal(updated.json().instance.runtimeState, 'stopped');
    assert.deepEqual(processCalls, []);
  } finally {
    await app.close();
  }
});

test('updates an enabled plugin through one stop, swap, and resume transaction', async () => {
  const oldDigest = 'sha512-pLYTYEdGdAXrWBlKrLcUtrTJ6mszT6dmHpBDFOFLuPh1qkJAqwQ+S/xT/ORvjislG6jAgrzmYWnzlZMa778iEA==';
  const { app, store, processCalls } = await harness({
    installedVersion: '0.1.0-alpha.2',
    installedDigest: oldDigest,
  });
  try {
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
      });
    });

    const updated = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/update',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        expectedCatalogVersion: entry.version,
        expectedPackageDigest: entry.packageDigest,
      },
    });

    assert.equal(updated.statusCode, 200, updated.payload);
    assert.equal(updated.json().instance.activationState, 'enabled');
    assert.equal(updated.json().instance.runtimeState, 'stopped');
    assert.equal(updated.json().instance.packageDigest, entry.packageDigest);
    assert.deepEqual(processCalls, ['stop:pi_official', 'start:pi_official']);
  } finally {
    await app.close();
  }
});

test('projects update resume failure as actionable error instead of owner-disabled', async () => {
  const oldDigest = 'sha512-pLYTYEdGdAXrWBlKrLcUtrTJ6mszT6dmHpBDFOFLuPh1qkJAqwQ+S/xT/ORvjislG6jAgrzmYWnzlZMa778iEA==';
  const { app, store, processCalls } = await harness({
    installedVersion: '0.1.0-alpha.2',
    installedDigest: oldDigest,
    start: async () => {
      throw new Error('new runtime failed');
    },
  });
  try {
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
      });
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/update',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        expectedCatalogVersion: entry.version,
        expectedPackageDigest: entry.packageDigest,
      },
    });

    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(response.json().code, 'UPDATE_RESUME_FAILED');
    const instance = (await store.snapshot()).instances[0];
    assert.equal(instance.activationState, 'error');
    assert.equal(instance.packageDigest, entry.packageDigest);
    assert.equal(instance.lastRuntimeError.code, 'UPDATE_RESUME_FAILED');
    assert.deepEqual(processCalls, ['stop:pi_official', 'start:pi_official']);
  } finally {
    await app.close();
  }
});

test('restores the old enabled runtime when the verified package swap fails', async () => {
  const oldDigest = 'sha512-pLYTYEdGdAXrWBlKrLcUtrTJ6mszT6dmHpBDFOFLuPh1qkJAqwQ+S/xT/ORvjislG6jAgrzmYWnzlZMa778iEA==';
  const { app, store, processCalls } = await harness({
    installedVersion: '0.1.0-alpha.2',
    installedDigest: oldDigest,
    update: async () => {
      throw new Error('swap rejected');
    },
  });
  try {
    await store.transaction((transaction) => {
      const current = transaction.instances.get('pi_official');
      transaction.instances.put({
        ...current,
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
      });
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/update',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 1,
        expectedCatalogVersion: entry.version,
        expectedPackageDigest: entry.packageDigest,
      },
    });

    assert.equal(response.statusCode, 500, response.payload);
    const instance = (await store.snapshot()).instances[0];
    assert.equal(instance.activationState, 'enabled');
    assert.equal(instance.packageDigest, oldDigest);
    assert.deepEqual(processCalls, ['stop:pi_official', 'start:pi_official']);
  } finally {
    await app.close();
  }
});

test('official plugin auth action is owner-only and gates enable until user OAuth completes', async () => {
  const authEntry = {
    ...entry,
    ownerAuth: {
      kind: 'lark-cli-device',
      runnerPath: 'node_modules/@larksuite/cli/scripts/run.js',
      domains: ['event', 'minutes', 'note', 'vc'],
    },
  };
  let authStatus = 'not_connected';
  const auth = {
    status: async () => ({ status: authStatus }),
    start: async () => ({
      status: 'waiting',
      verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=opaque&user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      qrDataUrl: 'data:image/png;base64,qr',
    }),
  };
  const { app, processCalls } = await harness({ catalog: [authEntry], auth });
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/plugins/official/pi_official/auth' });
    assert.equal(unauthenticated.statusCode, 401);

    const initial = await app.inject({
      method: 'GET',
      url: '/api/plugins/official/pi_official/auth',
      headers: readHeaders,
    });
    assert.equal(initial.statusCode, 200, initial.payload);
    assert.deepEqual(initial.json(), { status: 'not_connected' });

    const remoteStart = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/auth/start',
      headers: writeHeaders,
      remoteAddress: '203.0.113.10',
    });
    assert.equal(remoteStart.statusCode, 403);

    const started = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/auth/start',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(started.statusCode, 200, started.payload);
    assert.equal(started.json().status, 'waiting');
    assert.equal(started.json().userCode, 'ABCD-EFGH');
    assert.equal('deviceCode' in started.json(), false);

    const installed = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: installPayload,
    });
    assert.equal(installed.statusCode, 200, installed.payload);

    const blockedEnable = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(blockedEnable.statusCode, 409, blockedEnable.payload);
    assert.equal(blockedEnable.json().code, 'AUTH_REQUIRED');
    assert.deepEqual(processCalls, []);

    authStatus = 'connected';
    const enabled = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.deepEqual(processCalls, ['start:pi_official']);
  } finally {
    await app.close();
  }
});

test('install prepares but does not start; only explicit fenced enable starts the runtime', async () => {
  const { app, processCalls, installCalls } = await harness({
    auth: {
      status: async () => ({ status: 'connected' }),
      start: async () => {
        throw new Error('auth start is not expected after a verified login');
      },
    },
  });
  try {
    const installed = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: installPayload,
    });
    assert.equal(installed.statusCode, 200, installed.payload);
    assert.equal(installed.json().instance.configReadiness, 'ready');
    assert.equal(installed.json().instance.activationState, 'disabled');
    assert.deepEqual(installCalls, [
      {
        catalogId: entry.catalogId,
        expectedRelease: { version: entry.version, packageDigest: entry.packageDigest },
      },
    ]);
    assert.deepEqual(processCalls, []);

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/enable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.equal(enabled.json().instance.activationState, 'enabled');
    assert.deepEqual(processCalls, ['start:pi_official']);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/pi_official/disable',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 2 },
    });
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.deepEqual(processCalls, ['start:pi_official']);
  } finally {
    await app.close();
  }
});

test('official plugin mutations require direct localhost owner access', async () => {
  const { app } = await harness();
  try {
    const noSession = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(noSession.statusCode, 401);

    const remote = await app.inject({
      method: 'POST',
      url: '/api/plugins/official/feishu-meeting-intake/install',
      headers: writeHeaders,
      remoteAddress: '203.0.113.10',
    });
    assert.equal(remote.statusCode, 403);
  } finally {
    await app.close();
  }
});
