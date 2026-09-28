import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import { PluginManagerServiceError } from '../dist/domains/plugin/index.js';
import { pluginManagerUploadRoutes, registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';

const ownerUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
const readHeaders = { 'x-test-session-user': ownerUserId };
const writeHeaders = {
  host: 'localhost:3004',
  origin: 'http://localhost:5173',
  'x-test-session-user': ownerUserId,
};

const listed = {
  plugins: [
    {
      pluginId: 'official.video',
      pluginInstanceId: null,
      displayName: 'Video',
      source: {
        kind: 'catalog',
        catalogId: 'video',
        packageName: '@clowder-ai/video',
        trust: 'official',
      },
      availableVersion: '1.0.0',
      installedVersion: null,
      packageDigest: null,
      artifact: 'absent',
      config: 'incomplete',
      auth: 'not-required',
      intent: 'disabled',
      live: 'stopped',
      lifecycleRevision: null,
      capabilitySummary: [],
      actions: { install: true, setEnabled: false, uninstall: false, blockingReasons: [] },
    },
  ],
  catalog: { status: 'degraded', refreshedAt: 1_000, message: 'stale cache' },
};

async function harness({
  overrides = {},
  auditAppend,
  callbackRegistry,
  upload = false,
  asset,
  documentation,
  contributions,
} = {}) {
  const calls = [];
  const audits = [];
  const manager = {
    list: async () => {
      calls.push(['list']);
      return listed;
    },
    search: async (query) => {
      calls.push(['search', query]);
      return listed;
    },
    get: async (pluginId) => {
      calls.push(['get', pluginId]);
      return { plugin: { ...listed.plugins[0], capabilities: [], configFields: [] }, catalog: listed.catalog };
    },
    install: async (request) => {
      calls.push(['install', request]);
      return { pluginId: 'official.video', pluginInstanceId: 'pi_video' };
    },
    setEnabled: async (pluginId, request) => {
      calls.push(['set-enabled', pluginId, request]);
      return { pluginId, pluginInstanceId: 'pi_video' };
    },
    configure: async (pluginId, request) => {
      calls.push(['configure-contribution', pluginId, request]);
      return { pluginId, pluginInstanceId: 'pi_video' };
    },
    uninstall: async (pluginId, request) => {
      calls.push(['uninstall', pluginId, request]);
      return { pluginId, pluginInstanceId: 'pi_video' };
    },
    ...overrides,
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  const routeOptions = {
    manager,
    ...(asset ? { asset } : {}),
    ...(documentation ? { documentation } : {}),
    ...(contributions ? { contributions } : {}),
    ...(callbackRegistry ? { callbackRegistry } : {}),
    auditLog: {
      append: async (event) => {
        audits.push(event);
        return auditAppend?.(event);
      },
    },
  };
  registerPluginManagerRoutes(app, routeOptions);
  if (upload) await app.register(pluginManagerUploadRoutes, routeOptions);
  await app.ready();
  return { app, audits, calls };
}

test('serves package icons as authenticated same-origin resources with active-content confinement', async () => {
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>');
  const { app, calls } = await harness({
    asset: {
      readIcon: async (pluginId) => {
        assert.equal(pluginId, 'official.video');
        return { bytes, contentType: 'image/svg+xml', etag: '"asset-etag"' };
      },
    },
  });
  try {
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/plugin-manager/plugins/official.video/icon' })).statusCode,
      401,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugin-manager/plugins/official.video/icon',
      headers: readHeaders,
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.headers['content-type'], 'image/svg+xml');
    assert.equal(response.headers.etag, '"asset-etag"');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /sandbox/);
    assert.deepEqual(response.rawPayload, bytes);
    assert.deepEqual(calls, [], 'asset reads do not add a seventh Manager operation');
  } finally {
    await app.close();
  }
});

test('serves package README only to the direct owner Console without adding an Agent Manager operation', async () => {
  const reads = [];
  const { app, calls } = await harness({
    callbackRegistry: verifiedCallbackRegistry(),
    documentation: {
      readReadme: async (pluginId) => {
        reads.push(pluginId);
        return '# Video Analysis\n\nHuman-facing details.';
      },
    },
  });
  try {
    const path = '/api/plugin-manager/plugins/official.video/documentation';
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: path,
          headers: {
            host: 'localhost:3004',
            origin: 'http://localhost:3004',
            'x-invocation-id': 'inv-plugin',
            'x-callback-token': 'callback-secret',
          },
          remoteAddress: '127.0.0.1',
        })
      ).statusCode,
      401,
    );
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json(), { readmeMarkdown: '# Video Analysis\n\nHuman-facing details.' });
    assert.deepEqual(reads, ['official.video']);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

function multipartFile(bytes, { fieldName = 'file', filename = 'plugin.tgz' } = {}) {
  const boundary = '----cat-cafe-f202-plugin-upload';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
          'Content-Type: application/gzip\r\n\r\n',
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function verifiedCallbackRegistry({ policy } = {}) {
  return {
    verify: async (invocationId, callbackToken) =>
      invocationId === 'inv-plugin' && callbackToken === 'callback-secret'
        ? {
            ok: true,
            record: {
              invocationId,
              callbackToken,
              threadId: 'thread-plugin',
              userId: ownerUserId,
              catId: 'codex-sol',
              clientMessageIds: new Set(),
              createdAt: Date.now(),
              expiresAt: null,
              state: 'active',
              ...(policy === undefined ? {} : { toolExecutionPolicy: policy }),
            },
          }
        : { ok: false, reason: 'invalid_token' },
  };
}

test('exposes exactly the six canonical Manager state/lifecycle operations through one service', async () => {
  const { app, audits, calls } = await harness();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/plugin-manager/plugins' })).statusCode, 401);

    const list = await app.inject({ method: 'GET', url: '/api/plugin-manager/plugins', headers: readHeaders });
    assert.equal(list.statusCode, 200, list.payload);
    assert.equal(list.json().catalog.status, 'degraded');

    const search = await app.inject({
      method: 'GET',
      url: '/api/plugin-manager/plugins/search?q=scene',
      headers: readHeaders,
    });
    assert.equal(search.statusCode, 200, search.payload);

    const detail = await app.inject({
      method: 'GET',
      url: '/api/plugin-manager/plugins/official.video',
      headers: readHeaders,
    });
    assert.equal(detail.statusCode, 200, detail.payload);

    const install = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        source: { kind: 'catalog', catalogId: 'video' },
        expectedVersion: '1.0.0',
        expectedDigest: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      },
    });
    assert.equal(install.statusCode, 201, install.payload);

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/set-enabled',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { enabled: true, expectedRevision: 3 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);

    const uninstall = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/uninstall',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 4 },
    });
    assert.equal(uninstall.statusCode, 200, uninstall.payload);

    assert.deepEqual(calls, [
      ['list'],
      ['search', 'scene'],
      ['get', 'official.video'],
      [
        'install',
        {
          source: { kind: 'catalog', catalogId: 'video' },
          expectedVersion: '1.0.0',
          expectedDigest: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
        },
      ],
      ['set-enabled', 'official.video', { enabled: true, expectedRevision: 3 }],
      ['uninstall', 'official.video', { expectedRevision: 4 }],
    ]);
    assert.deepEqual(
      audits.map((event) => event.data.operation),
      ['install', 'set-enabled', 'uninstall'],
    );

    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/plugin-manager/plugins/official.video/update' })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/plugin-manager/plugins/official.video/repair' })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test('configuration is a revision-fenced typed contribution, not a seventh Agent management operation', async () => {
  const { app, audits, calls } = await harness();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/contributions/configuration',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        expectedRevision: 3,
        updates: [
          { key: 'provider', value: 'gemini' },
          { key: 'apiKey', value: 'secret-value' },
        ],
      },
    });

    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(calls, [
      [
        'configure-contribution',
        'official.video',
        {
          expectedRevision: 3,
          updates: [
            { key: 'provider', value: 'gemini' },
            { key: 'apiKey', value: 'secret-value' },
          ],
        },
      ],
    ]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].data.target, 'plugin-configuration-contribution');
    assert.deepEqual(audits[0].data.keys, ['provider', 'apiKey']);
    assert.equal(JSON.stringify(audits).includes('secret-value'), false);
  } finally {
    await app.close();
  }
});

test('write routes require direct loopback owner access before audit or service calls', async () => {
  const { app, audits, calls } = await harness();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/set-enabled',
      headers: writeHeaders,
      remoteAddress: '203.0.113.7',
      payload: { enabled: true, expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 403, response.payload);
    assert.deepEqual(audits, []);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test('verified Agent principal can read and mutate through the same owner/loopback gates', async () => {
  const { app, audits, calls } = await harness({ callbackRegistry: verifiedCallbackRegistry() });
  const callbackHeaders = {
    host: 'localhost:3004',
    origin: 'http://localhost:3004',
    'x-invocation-id': 'inv-plugin',
    'x-callback-token': 'callback-secret',
  };
  try {
    const list = await app.inject({
      method: 'GET',
      url: '/api/plugin-manager/plugins',
      headers: callbackHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(list.statusCode, 200, list.payload);

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/set-enabled',
      headers: callbackHeaders,
      remoteAddress: '127.0.0.1',
      payload: { enabled: true, expectedRevision: 3 },
    });
    assert.equal(enabled.statusCode, 200, enabled.payload);
    assert.deepEqual(calls, [['list'], ['set-enabled', 'official.video', { enabled: true, expectedRevision: 3 }]]);
    assert.equal(audits[0].data.operator, 'cat:codex-sol');
  } finally {
    await app.close();
  }
});

test('verified Agent principal discovers and invokes only active Host-supervised plugin tools', async () => {
  const contributionCalls = [];
  const inputSchema = {
    type: 'object',
    properties: { videoUrl: { type: 'string' } },
    required: ['videoUrl'],
  };
  const { app, audits } = await harness({
    callbackRegistry: verifiedCallbackRegistry(),
    contributions: {
      listPluginTools: async (pluginId) => {
        contributionCalls.push(['list-tools', pluginId]);
        return [
          {
            contributionId: 'video-analysis-toolset',
            name: 'video_analysis',
            description: 'Analyze a remote video.',
            inputSchema,
          },
        ];
      },
      callPluginTool: async (pluginId, contributionId, toolName, args) => {
        contributionCalls.push(['call', pluginId, contributionId, toolName, args]);
        return { content: [{ type: 'text', text: 'analyzed' }] };
      },
    },
  });
  const callbackHeaders = {
    host: 'localhost:3004',
    origin: 'http://localhost:3004',
    'x-invocation-id': 'inv-plugin',
    'x-callback-token': 'callback-secret',
  };
  try {
    const listedTools = await app.inject({
      method: 'GET',
      url: '/api/plugin-manager/plugins/official.video/contributions/tools',
      headers: callbackHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(listedTools.statusCode, 200, listedTools.payload);
    assert.deepEqual(listedTools.json(), {
      pluginId: 'official.video',
      tools: [
        {
          contributionId: 'video-analysis-toolset',
          name: 'video_analysis',
          description: 'Analyze a remote video.',
          inputSchema,
        },
      ],
    });

    const invoked = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/contributions/call',
      headers: callbackHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        contributionId: 'video-analysis-toolset',
        toolName: 'video_analysis',
        arguments: { videoUrl: 'https://media.example/video.mp4' },
      },
    });
    assert.equal(invoked.statusCode, 200, invoked.payload);
    assert.deepEqual(invoked.json(), { content: [{ type: 'text', text: 'analyzed' }] });
    assert.deepEqual(contributionCalls, [
      ['list-tools', 'official.video'],
      [
        'call',
        'official.video',
        'video-analysis-toolset',
        'video_analysis',
        { videoUrl: 'https://media.example/video.mp4' },
      ],
    ]);
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].data, {
      target: 'plugin-contribution',
      stage: 'requested',
      operator: 'cat:codex-sol',
      pluginId: 'official.video',
      contributionId: 'video-analysis-toolset',
      toolName: 'video_analysis',
    });
  } finally {
    await app.close();
  }
});

test('every restricted Agent policy is denied before Manager mutations and contribution calls', async () => {
  for (const policy of [{ mode: 'read_only', replayDeniedToolNames: [] }, { mode: 'collective_participation' }]) {
    const readOnlyHarness = await harness({ callbackRegistry: verifiedCallbackRegistry({ policy }) });
    try {
      const read = await readOnlyHarness.app.inject({
        method: 'GET',
        url: '/api/plugin-manager/plugins',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:3004',
          'x-invocation-id': 'inv-plugin',
          'x-callback-token': 'callback-secret',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(read.statusCode, 200, read.payload);

      const denied = await readOnlyHarness.app.inject({
        method: 'POST',
        url: '/api/plugin-manager/plugins/official.video/uninstall',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:3004',
          'x-invocation-id': 'inv-plugin',
          'x-callback-token': 'callback-secret',
        },
        remoteAddress: '127.0.0.1',
        payload: { expectedRevision: 3 },
      });
      assert.equal(denied.statusCode, 403, `${policy.mode}: ${denied.payload}`);
      const contributionDenied = await readOnlyHarness.app.inject({
        method: 'POST',
        url: '/api/plugin-manager/plugins/official.video/contributions/call',
        headers: {
          host: 'localhost:3004',
          origin: 'http://localhost:3004',
          'x-invocation-id': 'inv-plugin',
          'x-callback-token': 'callback-secret',
        },
        remoteAddress: '127.0.0.1',
        payload: {
          contributionId: 'video-analysis-toolset',
          toolName: 'video_analysis',
          arguments: {},
        },
      });
      assert.equal(contributionDenied.statusCode, 403, `${policy.mode}: ${contributionDenied.payload}`);
      assert.deepEqual(readOnlyHarness.audits, []);
      assert.deepEqual(readOnlyHarness.calls, [['list']]);
    } finally {
      await readOnlyHarness.app.close();
    }
  }
});

test('invalid Agent authority cannot reach a Manager mutation', async () => {
  const invalidHarness = await harness({ callbackRegistry: verifiedCallbackRegistry() });
  try {
    const denied = await invalidHarness.app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/uninstall',
      headers: {
        host: 'localhost:3004',
        origin: 'http://localhost:3004',
        'x-invocation-id': 'inv-plugin',
        'x-callback-token': 'wrong-secret',
      },
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 3 },
    });
    assert.equal(denied.statusCode, 401, denied.payload);
    assert.deepEqual(invalidHarness.audits, []);
    assert.deepEqual(invalidHarness.calls, []);
  } finally {
    await invalidHarness.app.close();
  }
});

test('multipart upload is a bounded transport adapter for local-archive install and cleans its temp path', async () => {
  let admittedPath;
  let existedDuringAdmission = false;
  const { app, audits, calls } = await harness({
    upload: true,
    overrides: {
      install: async (request) => {
        const { access } = await import('node:fs/promises');
        admittedPath = request.source.path;
        await access(admittedPath);
        existedDuringAdmission = true;
        calls.push(['install', request]);
        return { pluginId: 'local.uploaded', pluginInstanceId: 'pi_uploaded' };
      },
    },
  });
  const body = multipartFile(Buffer.from('archive bytes'));
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install/upload',
      headers: { ...writeHeaders, 'content-type': body.contentType },
      remoteAddress: '127.0.0.1',
      payload: body.payload,
    });
    assert.equal(response.statusCode, 201, response.payload);
    assert.equal(existedDuringAdmission, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].source.kind, 'local-archive');
    assert.equal(audits[0].data.sourceKind, 'local-archive');
    assert.equal(JSON.stringify(audits).includes(admittedPath), false);
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(admittedPath), { code: 'ENOENT' });
  } finally {
    await app.close();
  }
});

test('multipart upload rejects missing/wrong file parts before audit or Manager admission', async () => {
  const { app, audits, calls } = await harness({ upload: true });
  const body = multipartFile(Buffer.from('archive bytes'), { fieldName: 'not-file' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install/upload',
      headers: { ...writeHeaders, 'content-type': body.contentType },
      remoteAddress: '127.0.0.1',
      payload: body.payload,
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.deepEqual(audits, []);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test('closed request validation rejects ambiguous or extra mutation fields', async () => {
  const { app, audits, calls } = await harness();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/set-enabled',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { enabled: true, expectedRevision: 1, repair: true },
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json().code, 'INVALID_REQUEST');
    assert.deepEqual(audits, []);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test('audit admission is fail-closed and happens before each mutation', async () => {
  let serviceCalls = 0;
  const { app, calls } = await harness({
    overrides: {
      uninstall: async () => {
        serviceCalls += 1;
        throw new Error('must not run');
      },
    },
    auditAppend: async () => {
      throw new Error('disk unavailable');
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/uninstall',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1 },
    });
    assert.equal(response.statusCode, 503, response.payload);
    assert.equal(response.json().code, 'AUDIT_UNAVAILABLE');
    assert.equal(serviceCalls, 0);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test('maps stale revision and catalog fences to conflict without retrying', async () => {
  let calls = 0;
  const { app } = await harness({
    overrides: {
      setEnabled: async () => {
        calls += 1;
        throw new PluginManagerServiceError('STALE_REVISION', 'stale');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.video/set-enabled',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { enabled: false, expectedRevision: 3 },
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.deepEqual(response.json(), { error: 'stale', code: 'STALE_REVISION' });
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('local path install audit records source kind but never persists the raw path', async () => {
  const { app, audits } = await harness();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: { source: { kind: 'local-archive', path: '/private/tmp/secret-name.tgz' } },
    });
    assert.equal(response.statusCode, 201, response.payload);
    assert.equal(audits[0].data.sourceKind, 'local-archive');
    assert.equal(JSON.stringify(audits[0]).includes('/private/tmp/secret-name.tgz'), false);
  } finally {
    await app.close();
  }
});
