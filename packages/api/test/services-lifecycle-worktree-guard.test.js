import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { servicesRoutes } from '../dist/routes/services.js';

const SESSION_HEADERS = { 'x-test-session-user': 'you' };
const ORIGINAL_OWNER_ID = 'you';

/** Lifecycle stubs that prevent real process operations. */
const NOOP_LIFECYCLE = {
  findPidsByPort: async () => [],
  listProcesses: async () => [],
  readProcessCommand: async () => null,
  runScript: async () => ({ code: 0, output: 'ok' }),
  killPid: () => {
    throw new Error('should not kill');
  },
};

function buildWorktreeTestEnv(offset = '100') {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^CAT_CAFE_SERVICE_.*_ENABLED$/.test(key)),
  );
  for (const key of [
    'ASR_ENABLED',
    'TTS_ENABLED',
    'EMBED_ENABLED',
    'LLM_POSTPROCESS_ENABLED',
    'AUDIO_SERVICE_ENABLED',
  ]) {
    delete env[key];
  }
  env.CAT_CAFE_PROFILE = 'test';
  env.WORKTREE_PORT_OFFSET = offset;
  env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;
  return env;
}

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  const testEnv = options.env ?? buildWorktreeTestEnv();
  await app.register(servicesRoutes, {
    ...options,
    env: testEnv,
    fetchHealth: options.fetchHealth ?? (async () => ({ ok: false, status: 503, error: 'unreachable' })),
  });
  await app.ready();
  return app;
}

/** Save/restore DEFAULT_OWNER_USER_ID around a callback. */
async function withOwnerEnv(fn) {
  const prev = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = prev;
  }
}

describe('worktree sidecar guard', () => {
  it('rejects manual service start in worktree environment', () =>
    withOwnerEnv(async () => {
      let didRun = false;
      const app = await buildApp({
        lifecycle: {
          ...NOOP_LIFECYCLE,
          runScript: async () => {
            didRun = true;
            return { code: 0, output: 'started' };
          },
        },
      });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/services/embedding-model/start',
          headers: SESSION_HEADERS,
        });
        assert.equal(res.statusCode, 409, `Expected 409, got ${res.statusCode}: ${res.payload}`);
        assert.match(JSON.parse(res.payload).error, /worktree/i);
        assert.equal(didRun, false, 'Script should NOT have been run');
      } finally {
        await app.close();
      }
    }));

  it('startup reconciler skips auto-start in worktree environment (root cause path)', () =>
    withOwnerEnv(async () => {
      let runCount = 0;
      const configs = new Map([
        ['embedding-model', { installed: true, enabled: true, selectedModel: 'test-model' }],
        ['mlx-tts', { installed: true, enabled: true, selectedModel: 'mlx-community/Kokoro-82M-bf16' }],
      ]);
      const app = await buildApp({
        lifecycle: {
          ...NOOP_LIFECYCLE,
          autoStartEnabled: true,
          startupReadinessTimeoutMs: 250,
          startupProbeIntervalMs: 5,
          serviceConfig: {
            get: (id) => configs.get(id),
            set: (id, patch) => {
              const u = { ...(configs.get(id) ?? { enabled: false }), ...patch };
              configs.set(id, u);
              return u;
            },
          },
          runScript: async () => {
            runCount += 1;
            return { code: null, pid: 9900 + runCount, output: '' };
          },
        },
        fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
      });
      try {
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
        assert.equal(runCount, 0, `Reconciler should NOT start services in worktree, but started ${runCount}`);
      } finally {
        await app.close();
      }
    }));

  // Parameterized: all mutation routes reject in worktree (stop/uninstall/toggle/install)
  for (const { route, method, payload } of [
    { route: '/api/services/embedding-model/stop', method: 'POST' },
    { route: '/api/services/embedding-model/uninstall', method: 'POST' },
    { route: '/api/services/embedding-model/toggle', method: 'POST', payload: { enabled: true } },
    { route: '/api/services/embedding-model/install', method: 'POST' },
  ]) {
    const label = route.split('/').pop();
    it(`rejects ${label} in worktree environment`, () =>
      withOwnerEnv(async () => {
        const app = await buildApp({ lifecycle: NOOP_LIFECYCLE });
        try {
          const opts = { method, url: route, headers: SESSION_HEADERS };
          if (payload) {
            opts.headers = { ...SESSION_HEADERS, 'content-type': 'application/json' };
            opts.payload = JSON.stringify(payload);
          }
          const res = await app.inject(opts);
          assert.equal(res.statusCode, 409, `Expected 409 for ${label}, got ${res.statusCode}: ${res.payload}`);
          assert.match(JSON.parse(res.payload).error, /worktree/i);
        } finally {
          await app.close();
        }
      }));
  }

  it('rejects service start in alpha worktree (CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED)', () =>
    withOwnerEnv(async () => {
      const env = buildWorktreeTestEnv('0');
      delete env.WORKTREE_PORT_OFFSET;
      env.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED = '1';
      const app = await buildApp({ env, lifecycle: NOOP_LIFECYCLE });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/services/embedding-model/start',
          headers: SESSION_HEADERS,
        });
        assert.equal(res.statusCode, 409, `Expected 409 for alpha, got ${res.statusCode}: ${res.payload}`);
        assert.match(JSON.parse(res.payload).error, /worktree/i);
      } finally {
        await app.close();
      }
    }));

  it('reconciler skips auto-start in alpha worktree (CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED)', () =>
    withOwnerEnv(async () => {
      let runCount = 0;
      const configs = new Map([['embedding-model', { installed: true, enabled: true, selectedModel: 'test-model' }]]);
      const alphaEnv = buildWorktreeTestEnv('0');
      delete alphaEnv.WORKTREE_PORT_OFFSET;
      alphaEnv.CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED = '1';
      const app = await buildApp({
        env: alphaEnv,
        lifecycle: {
          ...NOOP_LIFECYCLE,
          autoStartEnabled: true,
          startupReadinessTimeoutMs: 250,
          startupProbeIntervalMs: 5,
          serviceConfig: {
            get: (id) => configs.get(id),
            set: (id, patch) => {
              const u = { ...(configs.get(id) ?? { enabled: false }), ...patch };
              configs.set(id, u);
              return u;
            },
          },
          runScript: async () => {
            runCount += 1;
            return { code: null, pid: 9900 + runCount, output: '' };
          },
        },
        fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
      });
      try {
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
        assert.equal(runCount, 0, `Reconciler should NOT start in alpha, but started ${runCount}`);
      } finally {
        await app.close();
      }
    }));

  it('allows service start when WORKTREE_PORT_OFFSET is 0 (runtime)', () =>
    withOwnerEnv(async () => {
      const app = await buildApp({ env: buildWorktreeTestEnv('0'), lifecycle: NOOP_LIFECYCLE });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/services/embedding-model/start',
          headers: SESSION_HEADERS,
        });
        assert.notEqual(res.statusCode, 409, `Got 409 for offset=0: ${res.payload}`);
      } finally {
        await app.close();
      }
    }));

  it('allows service start when WORKTREE_PORT_OFFSET is absent (runtime)', () =>
    withOwnerEnv(async () => {
      const env = buildWorktreeTestEnv('0');
      delete env.WORKTREE_PORT_OFFSET;
      const app = await buildApp({ env, lifecycle: NOOP_LIFECYCLE });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/services/embedding-model/start',
          headers: SESSION_HEADERS,
        });
        assert.notEqual(res.statusCode, 409, `Got 409 without offset: ${res.payload}`);
      } finally {
        await app.close();
      }
    }));
});
