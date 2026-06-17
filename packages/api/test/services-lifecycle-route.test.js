import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  findPidsByPort,
  isServiceProcessCommand,
  readProcessCommand,
  readServiceLogTail,
  resolveServiceScriptPath,
  runServiceScript,
  shouldDetachServiceRunner,
} from '../dist/domains/services/service-lifecycle.js';
import { servicesRoutes } from '../dist/routes/services.js';

const SESSION_HEADERS = { 'x-test-session-user': 'you' };
const TRUSTED_ORIGIN_HEADERS = { origin: 'http://localhost:3003', host: 'localhost:3003' };
const ORIGINAL_OWNER_ID = 'you';
process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  const testEnv = options.env === undefined ? { ...process.env, CAT_CAFE_PROFILE: 'test' } : options.env;
  await app.register(servicesRoutes, {
    ...options,
    env: testEnv,
    fetchHealth:
      options.fetchHealth ??
      (async () => ({
        ok: false,
        status: 503,
        error: 'unreachable',
      })),
  });
  await app.ready();
  return app;
}

function restoreOwner(previousOwner) {
  if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
}

describe('service lifecycle write routes', () => {
  it('exposes lifecycle write routes behind the owner gate', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.notEqual(res.statusCode, 404);
      assert.notEqual(res.statusCode, 401);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('allows direct-loopback lifecycle writes when DEFAULT_OWNER_USER_ID is unset', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const app = await buildApp({
      lifecycle: {
        runScript: async () => ({ code: 0, output: 'installed' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.notEqual(res.statusCode, 403, `should not 403 in permissive mode: ${res.payload}`);
      assert.notEqual(res.statusCode, 401, `should not 401 with valid session: ${res.payload}`);
    } finally {
      await app.close();
      restoreOwner(ORIGINAL_OWNER_ID);
    }
  });

  it('rejects non-loopback lifecycle writes when DEFAULT_OWNER_USER_ID is unset', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const app = await buildApp({
      lifecycle: {
        runScript: async () => ({ code: 0, output: 'installed' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
        remoteAddress: '192.168.1.100',
      });

      assert.equal(res.statusCode, 403, res.payload);
      assert.match(JSON.parse(res.payload).error, /non-localhost|DEFAULT_OWNER_USER_ID/);
    } finally {
      await app.close();
      restoreOwner(ORIGINAL_OWNER_ID);
    }
  });

  it('rejects proxy-forwarded loopback lifecycle writes when DEFAULT_OWNER_USER_ID is unset', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const app = await buildApp({
      lifecycle: {
        runScript: async () => ({ code: 0, output: 'installed' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: {
          ...SESSION_HEADERS,
          'x-forwarded-for': '203.0.113.50',
        },
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 403, res.payload);
      assert.match(JSON.parse(res.payload).error, /non-localhost|DEFAULT_OWNER_USER_ID/);
    } finally {
      await app.close();
      restoreOwner(ORIGINAL_OWNER_ID);
    }
  });

  it('rejects lifecycle writes when session user does not match DEFAULT_OWNER_USER_ID', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'bob';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 403, res.payload);
      assert.match(JSON.parse(res.payload).error, /configured owner/);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects trusted Origin fallback without an explicit session', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: TRUSTED_ORIGIN_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 401, res.payload);
      assert.match(JSON.parse(res.payload).error, /Authentication required/);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects concurrent lifecycle writes for the same service', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let releaseInstall;
    let started = false;
    const configs = new Map();
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () =>
          new Promise((resolve) => {
            started = true;
            releaseInstall = () => resolve({ code: 0, output: 'installed' });
          }),
      },
    });
    try {
      const first = app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });
      while (!started) await new Promise((resolve) => setImmediate(resolve));

      const second = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/uninstall',
        headers: SESSION_HEADERS,
      });

      assert.equal(second.statusCode, 409, second.payload);
      assert.match(JSON.parse(second.payload).error, /already in progress/);
      releaseInstall();
      assert.equal((await first).statusCode, 200);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('does not persist install model or port until the install lock is acquired and succeeds', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let releaseInstall;
    let started = false;
    const configs = new Map([
      ['whisper-stt', { enabled: false, installed: false, selectedModel: 'base', port: 19901 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        findPidsByPort: async () => [],
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () =>
          new Promise((resolve) => {
            started = true;
            releaseInstall = () => resolve({ code: 0, output: 'installed' });
          }),
      },
    });
    try {
      const first = app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'large-v3-turbo', port: 19902 },
      });
      while (!started) await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(
        configs.get('whisper-stt'),
        { enabled: false, installed: false, selectedModel: 'base', port: 19901 },
        'in-flight install must not expose uncommitted model or port',
      );

      const second = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'medium', port: 19903 },
      });

      assert.equal(second.statusCode, 409, second.payload);
      assert.deepEqual(
        configs.get('whisper-stt'),
        { enabled: false, installed: false, selectedModel: 'base', port: 19901 },
        'rejected install must not mutate persisted service config',
      );

      releaseInstall();
      assert.equal((await first).statusCode, 200);
      assert.deepEqual(configs.get('whisper-stt'), {
        enabled: false,
        installed: true,
        selectedModel: 'large-v3-turbo',
        port: 19902,
      });
    } finally {
      releaseInstall?.();
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('reports installing while an install runner is still active', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let releaseInstall;
    let started = false;
    const configs = new Map();
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () =>
          new Promise((resolve) => {
            started = true;
            releaseInstall = () => resolve({ code: 0, output: 'installed' });
          }),
      },
    });
    try {
      const install = app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });
      while (!started) await new Promise((resolve) => setImmediate(resolve));

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });

      const whisper = JSON.parse(listRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(whisper.status, 'installing');
      assert.equal(whisper.installed, false);
      releaseInstall();
      releaseInstall = null;
      assert.equal((await install).statusCode, 200);
    } finally {
      releaseInstall?.();
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('times out install scripts instead of waiting forever', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const app = await buildApp({
      lifecycle: {
        timeoutMs: 5,
        runScript: async () => new Promise(() => {}),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 408, res.payload);
      assert.match(JSON.parse(res.payload).error, /timed out/i);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('keeps the service lock until a timed-out lifecycle runner settles', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const releases = [];
    const app = await buildApp({
      lifecycle: {
        timeoutMs: 5,
        runScript: async () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ code: 0, output: 'settled' }));
          }),
      },
    });
    try {
      const write = (url, payload) => app.inject({ method: 'POST', url, headers: SESSION_HEADERS, payload });
      const first = await write('/api/services/whisper-stt/install', {
        model: 'mlx-community/whisper-large-v3-turbo',
      });
      assert.equal(first.statusCode, 408, first.payload);

      const second = await write('/api/services/whisper-stt/uninstall');
      assert.equal(second.statusCode, 409, second.payload);
    } finally {
      for (const release of releases) release();
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('reports uninstalling while an uninstall runner is still active', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = mkdtempSync(join(tmpdir(), 'service-uninstall-log-'));
    let releaseUninstall;
    let started = false;
    const configs = new Map([['whisper-stt', { installed: true, enabled: false }]]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () =>
          new Promise((resolve) => {
            started = true;
            releaseUninstall = () => resolve({ code: 0, output: 'uninstalled' });
          }),
      },
    });
    try {
      const uninstall = app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/uninstall',
        headers: SESSION_HEADERS,
      });
      while (!started) await new Promise((resolve) => setImmediate(resolve));

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });

      const whisper = JSON.parse(listRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(whisper.status, 'uninstalling');
      assert.equal(whisper.installed, true);
      assert.equal(whisper.enabled, false);
      assert.match(readServiceLogTail('whisper-stt', 20).join('\n'), /\[uninstall\] started/);

      releaseUninstall();
      releaseUninstall = null;
      assert.equal((await uninstall).statusCode, 200);
    } finally {
      releaseUninstall?.();
      await app.close();
      if (previousLogDir === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = previousLogDir;
      restoreOwner(previousOwner);
    }
  });

  it('stops owned service listeners before running uninstall', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = mkdtempSync(join(tmpdir(), 'service-uninstall-log-'));
    const killed = [];
    let didRun = false;
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const configs = new Map([['whisper-stt', { installed: true, enabled: true }]]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async (port) => (port === 9876 ? [5151] : []),
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
        killPid: (pid, signal) => {
          assert.equal(didRun, false, 'uninstall script must not run before pre-stop completes');
          killed.push({ pid, signal });
        },
        runScript: async () => {
          didRun = true;
          return { code: 0, output: 'uninstalled' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/uninstall',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(killed, [{ pid: 5151, signal: 'SIGTERM' }]);
      assert.equal(didRun, true);
      assert.deepEqual(configs.get('whisper-stt'), { installed: false, enabled: false });
      assert.match(
        readServiceLogTail('whisper-stt', 20).join('\n'),
        /stopped owned process\(es\) before uninstall: 5151/,
      );
    } finally {
      await app.close();
      if (previousLogDir === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = previousLogDir;
      restoreOwner(previousOwner);
    }
  });

  it('preserves the prior enabled state when uninstall script fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([['whisper-stt', { installed: true, enabled: true }]]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        runScript: async () => ({ code: 7, output: 'failed to remove venv' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/uninstall',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 422, res.payload);
      assert.deepEqual(configs.get('whisper-stt'), { installed: true, enabled: true });

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const whisper = JSON.parse(listRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(whisper.installed, true);
      assert.equal(whisper.enabled, true);
      assert.equal(whisper.status, 'unhealthy');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects reconfigure when the service is not installed', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => {
          throw new Error('reconfigure must not run a script for an uninstalled service');
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { port: 19999 },
      });
      assert.equal(res.statusCode, 409, res.payload);
      assert.match(JSON.parse(res.payload).error, /installed/i);
      assert.equal(configs.has('whisper-stt'), false);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects reconfigure when the service is enabled (must stop first)', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: true, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => {
          throw new Error('reconfigure must not run a script while the service is enabled');
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { port: 19999 },
      });
      assert.equal(res.statusCode, 409, res.payload);
      assert.match(JSON.parse(res.payload).error, /stop|disable/i);
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: true,
        selectedModel: 'large-v3-turbo',
        port: 19876,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('applies a port-only reconfigure without running the install script', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = mkdtempSync(join(tmpdir(), 'service-reconfigure-log-'));
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    let scriptRan = false;
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => {
          scriptRan = true;
          return { code: 0, output: 'unreachable' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { port: 19999 },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(scriptRan, false, 'port-only reconfigure must not invoke the install script');
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'large-v3-turbo',
        port: 19999,
      });
      assert.match(readServiceLogTail('whisper-stt', 20).join('\n'), /\[reconfigure\].*19876.*19999/);
    } finally {
      await app.close();
      if (previousLogDir === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = previousLogDir;
      restoreOwner(previousOwner);
    }
  });

  it('runs the install script and persists the new model on reconfigure', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const observedEnvs = [];
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async (input) => {
          observedEnvs.push(input.env);
          return { code: 0, output: 'model downloaded' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-small-mlx', port: 18887 },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(observedEnvs.length, 1, 'install script must run exactly once on model change');
      assert.equal(observedEnvs[0]?.WHISPER_MODEL, 'mlx-community/whisper-small-mlx');
      assert.equal(observedEnvs[0]?.WHISPER_PORT, '18887');
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'mlx-community/whisper-small-mlx',
        port: 18887,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('preserves prior model and port when reconfigure model download fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => ({ code: 1, output: 'huggingface download failed' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-small-mlx', port: 18887 },
      });
      assert.equal(res.statusCode, 422, res.payload);
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'large-v3-turbo',
        port: 19876,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('returns a no-op 200 when reconfigure receives identical model and port', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => {
          throw new Error('no-op reconfigure must not invoke install script');
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { model: 'large-v3-turbo', port: 19876 },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'large-v3-turbo',
        port: 19876,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects reconfigure with an out-of-range port', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { port: 70000 },
      });
      assert.equal(res.statusCode, 400, res.payload);
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'large-v3-turbo',
        port: 19876,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  // codex P2 2026-05-26: malformed payload field types must 400 instead of
  // silently coercing to undefined and returning "configuration unchanged".
  it('rejects reconfigure with non-string model payload', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { model: 42 },
      });
      assert.equal(res.statusCode, 400, res.payload);
      assert.match(JSON.parse(res.payload).error, /model.*string/);
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'large-v3-turbo',
        port: 19876,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects reconfigure with non-number port payload', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/reconfigure',
        headers: SESSION_HEADERS,
        payload: { port: '19999' },
      });
      assert.equal(res.statusCode, 400, res.payload);
      assert.match(JSON.parse(res.payload).error, /port.*number/);
      assert.deepEqual(configs.get('whisper-stt'), {
        installed: true,
        enabled: false,
        selectedModel: 'large-v3-turbo',
        port: 19876,
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('reconfigures a model-less service by updating only the port', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([['audio-capture', { installed: true, enabled: false, port: 9879 }]]);
    let scriptRan = false;
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => {
          scriptRan = true;
          return { code: 0, output: '' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/audio-capture/reconfigure',
        headers: SESSION_HEADERS,
        payload: { port: 9888 },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(scriptRan, false);
      assert.deepEqual(configs.get('audio-capture'), { installed: true, enabled: false, port: 9888 });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('exposes the persisted port in /api/services so the modal can pre-fill it', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      ['whisper-stt', { installed: true, enabled: false, selectedModel: 'large-v3-turbo', port: 19876 }],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: () => {
            throw new Error('GET /api/services must not write');
          },
        },
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/services', headers: SESSION_HEADERS });
      assert.equal(res.statusCode, 200);
      const whisper = JSON.parse(res.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(whisper.port, 19876, 'service DTO must expose the persisted port');
      assert.equal(whisper.selectedModel, 'large-v3-turbo');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('reports starting during detached startup grace after start returns', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([['whisper-stt', { installed: true, enabled: false }]]);
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 100,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async () => ({ code: null, pid: 321, output: '' }),
      },
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(startRes.statusCode, 200, startRes.payload);

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const whisper = JSON.parse(listRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(whisper.status, 'starting');
      assert.equal(whisper.installed, true);
      assert.equal(whisper.enabled, true);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('clears detached startup state when the runner settles before grace expires', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let releaseRunner;
    const configs = new Map([['whisper-stt', { installed: true, enabled: false }]]);
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 60_000,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async () => ({
          code: null,
          pid: 4321,
          output: '',
          settlement: new Promise((resolve) => {
            releaseRunner = () => resolve({ code: 1, pid: 4321, output: 'late startup failure' });
          }),
        }),
      },
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(startRes.statusCode, 200, startRes.payload);

      const startingRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const starting = JSON.parse(startingRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(starting.status, 'starting');

      releaseRunner();
      await new Promise((resolve) => setImmediate(resolve));

      const settledRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const settled = JSON.parse(settledRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(settled.status, 'unhealthy');
      assert.equal(settled.error, 'unreachable');
    } finally {
      releaseRunner?.();
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('keeps startup state while readiness probes fail during a slow detached start', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([['whisper-stt', { installed: true, enabled: false }]]);
    let ready = false;
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 5,
        startupReadinessTimeoutMs: 250,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async () => ({ code: null, pid: 4321, output: '' }),
      },
      fetchHealth: async () =>
        ready ? { ok: true, status: 200, error: null } : { ok: false, status: undefined, error: 'fetch failed' },
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(startRes.statusCode, 200, startRes.payload);

      await new Promise((resolve) => setTimeout(resolve, 30));

      const startingRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const starting = JSON.parse(startingRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(starting.status, 'starting');
      assert.equal(starting.error, null);

      ready = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const healthyRes = await app.inject({
          method: 'GET',
          url: '/api/services',
          headers: SESSION_HEADERS,
        });
        const healthy = JSON.parse(healthyRes.payload).services.find((service) => service.id === 'whisper-stt');
        if (healthy.status === 'healthy') {
          assert.equal(healthy.error, null);
          return;
        }
      }
      assert.fail('service should become healthy after readiness probe succeeds');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('fires the service ready hook after startup readiness succeeds', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map([
      [
        'embedding-model',
        {
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
        },
      ],
    ]);
    const readyEvents = [];
    let ready = false;
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 5,
        startupReadinessTimeoutMs: 250,
        startupProbeIntervalMs: 5,
        onServiceReady: (event) => {
          readyEvents.push({ serviceId: event.service.id, operator: event.operator, reason: event.reason });
        },
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async () => ({ code: null, pid: 4321, output: '' }),
      },
      fetchHealth: async () =>
        ready ? { ok: true, status: 200, error: null } : { ok: false, status: undefined, error: 'fetch failed' },
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/embedding-model/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(startRes.statusCode, 200, startRes.payload);

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(readyEvents, [], 'hook should wait for actual readiness');

      ready = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (readyEvents.length > 0) {
          assert.deepEqual(readyEvents, [{ serviceId: 'embedding-model', operator: 'you', reason: 'readiness' }]);
          return;
        }
      }
      assert.fail('service ready hook should fire after readiness probe succeeds');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('keeps startup state when a detached start wrapper exits before readiness later succeeds', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const runtimeScript = resolveServiceScriptPath('scripts/services/whisper-server.sh').replace(
      /whisper-server\.sh$/,
      'whisper-api.py',
    );
    const configs = new Map([
      [
        'whisper-stt',
        {
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
        },
      ],
    ]);
    let ready = false;
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 120,
        startupReadinessTimeoutMs: 120,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        listProcesses: async () => [
          {
            pid: 5512,
            command: `python3 ${runtimeScript} --model mlx-community/whisper-large-v3-turbo --port 9876`,
          },
        ],
        runScript: async () => ({
          code: 0,
          pid: 4401,
          output: '',
          settlement: Promise.resolve({ code: 0, pid: 4401, output: '' }),
        }),
      },
      fetchHealth: async () =>
        ready ? { ok: true, status: 200, error: null } : { ok: false, status: undefined, error: 'fetch failed' },
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(startRes.statusCode, 200, startRes.payload);

      await new Promise((resolve) => setTimeout(resolve, 75));
      const startingRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const starting = JSON.parse(startingRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(starting.status, 'starting');

      ready = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const healthyRes = await app.inject({
          method: 'GET',
          url: '/api/services',
          headers: SESSION_HEADERS,
        });
        const healthy = JSON.parse(healthyRes.payload).services.find((service) => service.id === 'whisper-stt');
        if (healthy.status === 'healthy') return;
      }
      assert.fail('service should become healthy after readiness probe succeeds');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('rejects an early clean-exit start when no owned runtime process remains', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let runCount = 0;
    const configs = new Map([
      [
        'whisper-stt',
        {
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
        },
      ],
    ]);
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 25,
        startupReadinessTimeoutMs: 25,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        listProcesses: async () => [],
        runScript: async () => {
          runCount += 1;
          return {
            code: 0,
            pid: 4401,
            output: '',
            settlement: Promise.resolve({ code: 0, pid: 4401, output: '' }),
          };
        },
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(startRes.statusCode, 502, startRes.payload);
      assert.match(
        JSON.parse(startRes.payload).error,
        /start script exited before service became reachable \(exit 0\)/,
      );
      assert.equal(configs.get('whisper-stt').enabled, false);

      const retryRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(retryRes.statusCode, 502, retryRes.payload);
      assert.equal(runCount, 2);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('releases startup state when a clean-exit runtime child disappears before readiness', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const runtimeScript = resolveServiceScriptPath('scripts/services/whisper-server.sh').replace(
      /whisper-server\.sh$/,
      'whisper-api.py',
    );
    let processProbeCount = 0;
    const configs = new Map([
      [
        'whisper-stt',
        {
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
        },
      ],
    ]);
    const app = await buildApp({
      lifecycle: {
        startupGraceMs: 500,
        startupReadinessTimeoutMs: 500,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        listProcesses: async () => {
          processProbeCount += 1;
          return processProbeCount === 1
            ? [
                {
                  pid: 5512,
                  command: `python3 ${runtimeScript} --model mlx-community/whisper-large-v3-turbo --port 9876`,
                },
              ]
            : [];
        },
        runScript: async () => ({
          code: 0,
          pid: 4401,
          output: '',
          settlement: Promise.resolve({ code: 0, pid: 4401, output: '' }),
        }),
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(startRes.statusCode, 200, startRes.payload);

      await new Promise((resolve) => setTimeout(resolve, 120));
      const settledRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const settled = JSON.parse(settledRes.payload).services.find((service) => service.id === 'whisper-stt');
      assert.equal(settled.status, 'unhealthy');
      assert.equal(settled.error, 'fetch failed');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('accepts a clean-exit launcher when an owned runtime child process is still active', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const runtimeScript = resolveServiceScriptPath('scripts/services/whisper-server.sh').replace(
      /whisper-server\.sh$/,
      'whisper-api.py',
    );
    const configs = new Map([
      [
        'whisper-stt',
        {
          installed: true,
          enabled: false,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
        },
      ],
    ]);
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        listProcesses: async () => [
          {
            pid: 5512,
            command: `python3 ${runtimeScript} --model mlx-community/whisper-large-v3-turbo --port 9876`,
          },
        ],
        runScript: async () => ({ code: 0, pid: 4401, output: '' }),
        startupReadinessTimeoutMs: 0,
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'still starting' }),
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(startRes.statusCode, 200, startRes.payload);
      assert.match(JSON.parse(startRes.payload).message, /start initiated/);
      assert.equal(configs.get('whisper-stt').enabled, true);
      assert.match(readServiceLogTail('whisper-stt', 20).join('\n'), /owned runtime process\(es\) still active: 5512/);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('restarts an owned listener when it is not service-healthy', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const configs = new Map([
      [
        'whisper-stt',
        {
          installed: true,
          enabled: true,
          selectedModel: 'mlx-community/whisper-large-v3-turbo',
        },
      ],
    ]);
    const killed = [];
    let didRun = false;
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => (killed.length > 0 ? [] : [5151]),
        readProcessCommand: async () => `bash ${resolvedScript}`,
        killPid: (pid, signal) => killed.push({ pid, signal }),
        runScript: async () => {
          didRun = true;
          return { code: null, pid: 4405, output: '' };
        },
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
    });
    try {
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(startRes.statusCode, 200, startRes.payload);
      assert.equal(didRun, true);
      assert.deepEqual(killed, [{ pid: 5151, signal: 'SIGTERM' }]);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('auto-starts enabled installed services on API startup through the lifecycle runner', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let runCount = 0;
    const configs = new Map([
      [
        'mlx-tts',
        {
          installed: true,
          enabled: true,
          selectedModel: 'mlx-community/Kokoro-82M-bf16',
        },
      ],
      ['whisper-stt', { installed: true, enabled: false }],
    ]);
    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 250,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async (input) => {
          runCount += 1;
          assert.equal(input.serviceId, 'mlx-tts');
          assert.equal(input.action, 'start');
          assert.equal(input.detached, true);
          assert.equal(input.env.TTS_MODEL, 'mlx-community/Kokoro-82M-bf16');
          return { code: null, pid: 5500 + runCount, output: '' };
        },
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
    });
    try {
      for (let attempt = 0; attempt < 20 && runCount === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(runCount, 1, 'startup reconciler should start only enabled installed services');

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      const services = JSON.parse(listRes.payload).services;
      const tts = services.find((service) => service.id === 'mlx-tts');
      const whisper = services.find((service) => service.id === 'whisper-stt');
      assert.equal(tts.status, 'starting');
      assert.equal(tts.error, null);
      assert.equal(whisper.status, 'not_configured');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('auto-starts explicitly enabled legacy env services when services.json is missing', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let startedEnv = null;
    const configs = new Map();
    const app = await buildApp({
      env: {
        CAT_CAFE_SERVICE_ASR_ENABLED: '1',
        WHISPER_MODEL: 'base',
        WHISPER_PORT: '19976',
      },
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 250,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async (input) => {
          startedEnv = input.env;
          assert.equal(input.serviceId, 'whisper-stt');
          assert.equal(input.action, 'start');
          return { code: null, pid: 5510, output: '' };
        },
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
    });
    try {
      for (let attempt = 0; attempt < 20 && startedEnv === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(startedEnv?.WHISPER_MODEL, 'base');
      assert.equal(startedEnv?.WHISPER_PORT, '19976');
      assert.equal(configs.get('whisper-stt').enabled, true);
      assert.equal(configs.get('whisper-stt').installed, true);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('does not treat profile default legacy flags as explicit service enables', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let runCount = 0;
    const app = await buildApp({
      env: {
        CAT_CAFE_PROFILE: 'dev',
        ASR_ENABLED: '1',
        WHISPER_MODEL: 'base',
      },
      lifecycle: {
        autoStartEnabled: true,
        serviceConfig: {
          get: () => undefined,
          set: () => ({ enabled: true }),
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
        runScript: async () => {
          runCount += 1;
          return { code: 0, output: 'unexpected' };
        },
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        runCount,
        0,
        'profile default ASR_ENABLED=1 must not auto-start without CAT_CAFE_SERVICE_ASR_ENABLED',
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('cleans up disabled owned service listeners on API startup', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const killed = [];
    const resolvedScript = resolveServiceScriptPath('scripts/services/tts-server.sh');
    const apiScript = resolvedScript.replace(/tts-server\.sh$/, 'tts-api.py');
    const configs = new Map([['mlx-tts', { installed: true, enabled: false }]]);
    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async (port) => (port === 9879 ? [5151] : []),
        readProcessCommand: async () => `python3 ${apiScript} --model edge-tts --port 9879`,
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
        },
      },
    });
    try {
      for (let attempt = 0; attempt < 20 && killed.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(killed, [{ pid: 5151, signal: 'SIGTERM' }]);
      assert.deepEqual(configs.get('mlx-tts'), { installed: true, enabled: false });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('does not let startup disabled cleanup kill a concurrent user start', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const killed = [];
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const configs = new Map([['whisper-stt', { installed: true, enabled: false, selectedModel: 'base' }]]);
    let resolveStartRun;
    const startRunEntered = new Promise((resolve) => {
      resolveStartRun = resolve;
    });
    let releaseStartRun;
    const startRunRelease = new Promise((resolve) => {
      releaseStartRun = resolve;
    });
    let startPortProbeConsumed = false;
    const app = await buildApp({
      lifecycle: {
        autoStartEnabled: true,
        startupReadinessTimeoutMs: 250,
        startupProbeIntervalMs: 5,
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => {
          if (!startPortProbeConsumed) {
            startPortProbeConsumed = true;
            return [];
          }
          return [5151];
        },
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
        },
        runScript: async (input) => {
          if (input.serviceId !== 'whisper-stt' || input.action !== 'start') return { code: 0, output: 'noop' };
          resolveStartRun();
          await startRunRelease;
          return { code: null, pid: 5515, output: '' };
        },
      },
      fetchHealth: async () => ({ ok: false, status: undefined, error: 'fetch failed' }),
    });
    try {
      const startResPromise = app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      await startRunEntered;
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.deepEqual(killed, [], 'startup cleanup must respect the active start lifecycle lock');

      releaseStartRun();
      const startRes = await startResPromise;
      assert.equal(startRes.statusCode, 200, startRes.payload);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('captures detached runner output after the early start response', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'service-log-'));
    const previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = logDir;
    const dir = mkdtempSync(join(tmpdir(), 'service-start-'));
    const script = join(dir, 'late-fail.sh');
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        'echo "boot line before readiness"',
        'sleep 2.1',
        'echo "late startup failure detail" >&2',
        'exit 7',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(script, 0o755);
    // After earlyExit fires, the runner unref's child + stdout + stderr
    // so a production API server can restart without being blocked by
    // a long-lived sidecar's pipe handles. That leaves no active handle
    // keeping the event loop alive while we `await result.settlement`,
    // so the Node test runner cancels the pending promise. A test-scoped
    // ref'd interval keeps the loop alive until settlement resolves.
    const keepalive = setInterval(() => {}, 5_000);
    try {
      const result = await runServiceScript({
        serviceId: 'whisper-stt',
        action: 'start',
        scriptPath: script,
        detached: true,
        timeoutMs: 10_000,
      });

      assert.equal(result.code, null);
      assert.equal(typeof result.pid, 'number');
      assert.ok(result.settlement, 'detached start should expose late process settlement');

      const settled = await result.settlement;
      assert.equal(settled.code, 7);
      assert.match(settled.output, /late startup failure detail/);
      assert.match(readServiceLogTail('whisper-stt', 20).join('\n'), /late startup failure detail/);
      assert.match(readServiceLogTail('whisper-stt', 20).join('\n'), /\[start\] process exited with code 7/);
    } finally {
      clearInterval(keepalive);
      if (previousLogDir === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = previousLogDir;
    }
  });

  it('records the runner invocation and clean early exit in service logs', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'service-log-'));
    const previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = logDir;
    const dir = mkdtempSync(join(tmpdir(), 'service-start-'));
    const script = join(dir, 'clean-exit.sh');
    writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    chmodSync(script, 0o755);

    try {
      const result = await runServiceScript({
        serviceId: 'whisper-stt',
        action: 'start',
        scriptPath: script,
        detached: true,
        timeoutMs: 10_000,
      });

      assert.equal(result.code, 0);
      const log = readServiceLogTail('whisper-stt', 20).join('\n');
      assert.match(log, /\[start\] invoking runner: bash .*clean-exit\.sh/);
      assert.match(log, /\[start\] runner pid=\d+/);
      assert.match(log, /\[start\] runner exited with code 0/);
    } finally {
      if (previousLogDir === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = previousLogDir;
    }
  });

  it('refuses to start when the service port belongs to another process', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let didRun = false;
    const app = await buildApp({
      lifecycle: {
        findPidsByPort: async () => [4242],
        readProcessCommand: async () => 'python unrelated-server.py --port 9876',
        serviceConfig: {
          get: () => undefined,
          set: () => ({ enabled: false }),
        },
        runScript: async () => {
          didRun = true;
          return { code: 0, output: 'started' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 409, res.payload);
      assert.match(JSON.parse(res.payload).error, /port .*9876/i);
      assert.equal(didRun, false);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('stops only strict-matched service processes on the service port', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const killed = [];
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const app = await buildApp({
      lifecycle: {
        findPidsByPort: async () => [5151],
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/stop',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(killed, [{ pid: 5151, signal: 'SIGTERM' }]);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('stops Python API processes launched by the service wrapper after an API restart', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const killed = [];
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const apiScript = resolvedScript.replace(/whisper-server\.sh$/, 'whisper-api.py');
    const app = await buildApp({
      lifecycle: {
        findPidsByPort: async () => [5151],
        readProcessCommand: async () => `python3 ${apiScript} --model base --port 9876`,
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/stop',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(killed, [{ pid: 5151, signal: 'SIGTERM' }]);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('stores lifecycle toggle config without exposing script handles', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/toggle',
        headers: SESSION_HEADERS,
        payload: { enabled: true, model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(JSON.parse(res.payload).config, {
        enabled: true,
        selectedModel: 'mlx-community/whisper-large-v3-turbo',
      });
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('persists selectedModel on install and injects it into start env', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    let startEnv = null;
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async (input) => {
          if (input.action === 'start') startEnv = input.env;
          if (input.action === 'start') return { code: null, pid: 4402, output: '' };
          return { code: 0, output: 'ok' };
        },
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
      },
    });
    try {
      const installRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });
      assert.equal(installRes.statusCode, 200, installRes.payload);
      assert.equal(configs.get('whisper-stt').selectedModel, 'mlx-community/whisper-large-v3-turbo');
      assert.equal(configs.get('whisper-stt').installed, true);
      assert.equal(configs.get('whisper-stt').enabled, false);

      const startRes = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(startRes.statusCode, 200, startRes.payload);
      assert.equal(startEnv?.WHISPER_MODEL, 'mlx-community/whisper-large-v3-turbo');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('persists an auto-selected service port during install', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    let installEnv = null;
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async (port) => (port === 9876 ? [5151] : []),
        readProcessCommand: async () => null,
        runScript: async (input) => {
          if (input.action === 'install') installEnv = input.env;
          return { code: 0, output: 'installed' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(installEnv?.WHISPER_PORT, '9877');
      assert.equal(configs.get('whisper-stt').port, 9877);
      assert.equal(configs.get('whisper-stt').selectedModel, 'mlx-community/whisper-large-v3-turbo');
      assert.equal(configs.get('whisper-stt').installed, true);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('install preserves existing enabled=true for running services', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    configs.set('whisper-stt', { installed: true, enabled: true });
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => ({ code: 0, output: 'reinstalled' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(configs.get('whisper-stt').installed, true);
      assert.equal(configs.get('whisper-stt').enabled, true, 'reinstall should preserve enabled=true');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('persists enabled=true after successful start', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => ({ code: null, pid: 4403, output: '' }),
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const config = configs.get('whisper-stt');
      assert.equal(config.installed, true, 'should persist installed=true after start');
      assert.equal(config.enabled, true, 'should persist enabled=true after start');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('supports set-only serviceConfig overrides on start', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        runScript: async () => ({ code: null, pid: 4404, output: '' }),
        findPidsByPort: async () => [],
        readProcessCommand: async () => null,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(configs.get('whisper-stt').installed, true);
      assert.equal(configs.get('whisper-stt').enabled, true);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('persists enabled=false after successful stop', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const configs = new Map();
    configs.set('whisper-stt', { installed: true, enabled: true });
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async () => [12345],
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
        killPid: () => {},
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/stop',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const config = configs.get('whisper-stt');
      assert.equal(config.enabled, false, 'should persist enabled=false after stop');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('GET /api/services reads from injected serviceConfig store, not hardcoded getServiceConfig', async () => {
    const configs = new Map();
    configs.set('whisper-stt', { installed: true, enabled: true, selectedModel: 'test/model' });
    const app = await buildApp({
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const { services } = JSON.parse(res.payload);
      const whisper = services.find((s) => s.id === 'whisper-stt');
      assert.ok(whisper, 'whisper-stt should be in the response');
      assert.equal(whisper.installed, true, 'should reflect injected config installed=true');
      assert.equal(whisper.enabled, true, 'should reflect injected config enabled=true');
    } finally {
      await app.close();
    }
  });

  it('GET /api/services/endpoints reads from injected serviceConfig store', async () => {
    const configs = new Map();
    configs.set('whisper-stt', { installed: true, enabled: true, port: 19876 });
    const app = await buildApp({
      env: {},
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/endpoints',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const { endpoints } = JSON.parse(res.payload);
      assert.equal(endpoints['whisper-stt'], 'http://127.0.0.1:19876');
    } finally {
      await app.close();
    }
  });

  it('GET /api/services/:id/health reads from injected serviceConfig store', async () => {
    const configs = new Map();
    configs.set('whisper-stt', { installed: true, enabled: true });
    const app = await buildApp({
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id),
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/whisper-stt/health',
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.equal(body.status, 'healthy', 'injected config enabled=true triggers health check instead of idle');
      assert.equal(body.configured, true);
    } finally {
      await app.close();
    }
  });

  it('keeps service script paths inside the repository services directory', () => {
    assert.match(
      resolveServiceScriptPath('scripts/services/whisper-install.sh'),
      /scripts\/services\/whisper-install\.sh$/,
    );
    assert.throws(() => resolveServiceScriptPath('../cat-cafe-runtime/.env'), /outside/i);
  });

  it('uses native PowerShell service scripts on Windows', () => {
    assert.match(
      resolveServiceScriptPath('scripts/services/whisper-install.sh', 'win32'),
      /scripts\/services\/whisper-install\.ps1$/,
    );
    assert.match(
      resolveServiceScriptPath('scripts/services/whisper-uninstall.sh', 'win32'),
      /scripts\/services\/whisper-uninstall\.ps1$/,
    );
    assert.match(
      resolveServiceScriptPath('scripts/services/audio-capture-install.sh', 'win32'),
      /scripts\/services\/audio-capture-install\.ps1$/,
    );
    assert.match(
      resolveServiceScriptPath('scripts/services/audio-capture-server.sh', 'win32'),
      /scripts\/services\/audio-capture-server\.ps1$/,
    );
    assert.match(
      resolveServiceScriptPath('scripts/services/audio-capture-uninstall.sh', 'win32'),
      /scripts\/services\/audio-capture-uninstall\.ps1$/,
    );
  });

  it('keeps shell service scripts on Windows when no PowerShell counterpart exists', () => {
    assert.match(
      resolveServiceScriptPath('scripts/services/qwen3-asr-server.sh', 'win32'),
      /scripts\/services\/qwen3-asr-server\.sh$/,
    );
  });

  // PIDs use high values (90xxx) to avoid collision with process.pid — parsePidLines
  // filters out the current process PID, and in --test-isolation=process mode the test
  // runner can assign low PIDs (e.g. 222) that would collide with mock values.
  it('uses Windows-native port and command probes instead of lsof/ps', async () => {
    const calls = [];
    const fakeExecFile = (command, args, _options, callback) => {
      calls.push({ command, args });
      const commandText = args.join(' ');
      if (commandText.includes('Get-NetTCPConnection')) {
        callback(null, "90111\r\n90222\r\n''\r\n", '');
      } else if (commandText.includes('Get-CimInstance')) {
        callback(null, 'powershell.exe -File C:\\repo\\scripts\\services\\whisper-server.ps1\r\n', '');
      } else {
        callback(new Error(`unexpected command: ${command} ${args.join(' ')}`), '', '');
      }
      return { on: () => {} };
    };

    const pids = await findPidsByPort(9876, { platform: 'win32', execFile: fakeExecFile });
    const command = await readProcessCommand(90111, { platform: 'win32', execFile: fakeExecFile });

    assert.deepEqual(pids, [90111, 90222]);
    assert.equal(command, 'powershell.exe -File C:\\repo\\scripts\\services\\whisper-server.ps1');
    assert.equal(calls[0].command, 'powershell.exe');
    assert.equal(calls[1].command, 'powershell.exe');
  });

  it('falls back to netstat when the Windows PowerShell port probe is unavailable', async () => {
    const calls = [];
    const fakeExecFile = (command, args, _options, callback) => {
      calls.push({ command, args });
      const commandText = args.join(' ');
      if (commandText.includes('Get-NetTCPConnection')) {
        callback(new Error('Get-NetTCPConnection failed'), '', '');
      } else if (command === 'netstat.exe') {
        callback(
          null,
          [
            '  Proto  Local Address          Foreign Address        State           PID',
            '  TCP    0.0.0.0:9876           0.0.0.0:0              LISTENING       90111',
            '  TCP    [::]:9876              [::]:0                 LISTENING       90222',
            '  TCP    127.0.0.1:19876        0.0.0.0:0              LISTENING       90333',
            '  TCP    127.0.0.1:9876         127.0.0.1:50000        ESTABLISHED     90444',
          ].join('\r\n'),
          '',
        );
      } else {
        callback(new Error(`unexpected command: ${command} ${args.join(' ')}`), '', '');
      }
      return { on: () => {} };
    };

    const pids = await findPidsByPort(9876, { platform: 'win32', execFile: fakeExecFile });

    assert.deepEqual(pids, [90111, 90222]);
    assert.equal(calls[0].command, 'powershell.exe');
    assert.equal(calls[1].command, 'netstat.exe');
  });

  it('matches service processes by exact script identity only', () => {
    const manifest = {
      id: 'mlx-tts',
      scripts: { start: 'scripts/services/tts-server.sh' },
    };
    const resolvedScript = resolveServiceScriptPath('scripts/services/tts-server.sh');

    assert.equal(isServiceProcessCommand('bash scripts/services/tts-server.sh', manifest), false);
    assert.equal(isServiceProcessCommand(`/bin/bash ${resolvedScript}`, manifest), true);
    assert.equal(isServiceProcessCommand('/bin/bash /tmp/scripts/services/tts-server.sh', manifest), false);
    assert.equal(isServiceProcessCommand('bash tts-server.sh', manifest), false);
    assert.equal(isServiceProcessCommand(`python worker.py --payload "${resolvedScript}"`, manifest), false);
    assert.equal(isServiceProcessCommand('python -m mlx.server --port 9879', manifest), false);
    assert.equal(isServiceProcessCommand('node unrelated-tts-helper.js', manifest), false);
  });

  it('matches service-owned Python API processes by exact runtime script identity', () => {
    const manifest = {
      id: 'mlx-tts',
      scripts: { start: 'scripts/services/tts-server.sh' },
    };
    const resolvedScript = resolveServiceScriptPath('scripts/services/tts-server.sh');
    const apiScript = resolvedScript.replace(/tts-server\.sh$/, 'tts-api.py');

    assert.equal(isServiceProcessCommand(`python3 ${apiScript} --model edge-tts --port 9879`, manifest), true);
    assert.equal(isServiceProcessCommand(`/opt/cat/venv/bin/python "${apiScript}" --port 9879`, manifest), true);
    assert.equal(isServiceProcessCommand(`python worker.py --payload "${apiScript}"`, manifest), false);
    assert.equal(isServiceProcessCommand('python /tmp/scripts/services/tts-api.py --port 9879', manifest), false);
  });

  it('matches macOS Python.app service-owned API processes by exact runtime script identity', () => {
    const manifest = {
      id: 'embedding-model',
      scripts: { start: 'scripts/services/embed-server.sh' },
    };
    const resolvedScript = resolveServiceScriptPath('scripts/services/embed-server.sh');
    const apiScript = resolvedScript.replace(/embed-server\.sh$/, 'embed-api.py');
    const pythonAppExecutable =
      '/opt/homebrew/Cellar/python@3.14/3.14.2/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python';

    assert.equal(
      isServiceProcessCommand(
        `${pythonAppExecutable} ${apiScript} --model mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ --port 9880`,
        manifest,
      ),
      true,
    );
    assert.equal(
      isServiceProcessCommand(`${pythonAppExecutable} /tmp/scripts/services/embed-api.py --port 9880`, manifest),
      false,
    );
  });

  it('matches Windows PowerShell service processes by exact script identity', () => {
    const manifest = {
      id: 'whisper-stt',
      scripts: { start: 'scripts/services/whisper-server.sh' },
    };
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh', 'win32');

    assert.equal(
      isServiceProcessCommand(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${resolvedScript}"`,
        manifest,
        'win32',
      ),
      true,
    );
    assert.equal(
      isServiceProcessCommand(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -FILE "${resolvedScript}"`,
        manifest,
        'win32',
      ),
      true,
    );
    assert.equal(
      isServiceProcessCommand(
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\tmp\\whisper-server.ps1',
        manifest,
        'win32',
      ),
      false,
    );
  });

  it('does not request OS-level detached spawn for Windows service runners', () => {
    assert.equal(shouldDetachServiceRunner('win32'), false);
    assert.equal(shouldDetachServiceRunner('darwin'), true);
    assert.equal(shouldDetachServiceRunner('linux'), true);
  });

  it('keeps Windows PowerShell service wrappers observable at the runner and Python boundary', () => {
    const wrappers = [
      ['whisper-stt', 'scripts/services/whisper-server.sh'],
      ['mlx-tts', 'scripts/services/tts-server.sh'],
      ['embedding-model', 'scripts/services/embed-server.sh'],
      ['llm-postprocess', 'scripts/services/llm-postprocess-server.sh'],
      ['audio-capture', 'scripts/services/audio-capture-server.sh'],
    ];

    for (const [serviceId, scriptPath] of wrappers) {
      const source = readFileSync(resolveServiceScriptPath(scriptPath, 'win32'), 'utf8');
      assert.match(source, new RegExp(`\\[start\\] wrapper entered: service=${serviceId}`));
      assert.match(source, /\[start\] resolved runtime:/);
      assert.match(source, /\[start\] launching python:/);
      assert.match(source, /\[start\] python exited with code/);
    }
  });

  it('keeps shell service wrappers observable at the runner and Python boundary', () => {
    const wrappers = [
      ['whisper-stt', 'scripts/services/whisper-server.sh'],
      ['mlx-tts', 'scripts/services/tts-server.sh'],
      ['embedding-model', 'scripts/services/embed-server.sh'],
      ['llm-postprocess', 'scripts/services/llm-postprocess-server.sh'],
      ['audio-capture', 'scripts/services/audio-capture-server.sh'],
    ];

    for (const [serviceId, scriptPath] of wrappers) {
      const source = readFileSync(resolveServiceScriptPath(scriptPath), 'utf8');
      assert.match(source, new RegExp(`\\[start\\] wrapper entered: service=${serviceId}`));
      assert.match(source, /\[start\] resolved runtime:/);
      assert.match(source, /\[start\] launching python:/);
      assert.match(source, /\[start\] python exited with code/);
    }
  });

  it('marks timed-out scripts even when they emitted output before termination', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'cat-cafe-service-timeout-'));
    const scriptPath = join(scriptDir, 'slow.sh');
    writeFileSync(scriptPath, 'printf "started\\n"; sleep 2\n');

    const result = await runServiceScript({
      serviceId: 'test-service',
      action: 'install',
      scriptPath,
      timeoutMs: 20,
    });

    assert.equal(result.timedOut, true);
    assert.match(result.output ?? '', /started/);
  });
});

describe('deep health probe (zombie detection)', () => {
  it('kills zombie process when shallow health passes but deep health fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const killed = [];
    let scriptRan = false;
    const zombieAlive = { value: true };
    const ttsStartScript = resolveServiceScriptPath('scripts/services/tts-server.sh');
    const configs = new Map([
      ['mlx-tts', { installed: true, enabled: true, selectedModel: 'mlx-community/Kokoro-82M-bf16' }],
    ]);
    const app = await buildApp({
      fetchHealth: async (url) => {
        // Zombie deep health always fails (synthesis broken)
        if (url.includes('/health/deep') && zombieAlive.value) {
          return { ok: false, status: 503, error: 'synthesis probe failed: Broken pipe' };
        }
        // After zombie is killed and script runs, new process is healthy
        if (!zombieAlive.value && scriptRan) {
          return { ok: true, status: 200, error: null };
        }
        // Zombie shallow health passes
        if (zombieAlive.value) {
          return { ok: true, status: 200, error: null };
        }
        // Between kill and restart — no process
        return { ok: false, status: 503, error: 'unreachable' };
      },
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async (port) => {
          if (port === 9879 && zombieAlive.value) return [55852];
          return [];
        },
        readProcessCommand: async (pid) => (pid === 55852 ? `/bin/bash ${ttsStartScript}` : ''),
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
          if (pid === 55852) zombieAlive.value = false;
        },
        runScript: async () => {
          scriptRan = true;
          return { code: 0, output: 'started' };
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/mlx-tts/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.payload}`);
      assert.deepEqual(killed, [{ pid: 55852, signal: 'SIGTERM' }], 'zombie process should be killed');
      assert.equal(scriptRan, true, 'start script should run after killing zombie');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('returns already-running when both shallow and deep health pass', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const killed = [];
    const ttsStartScript = resolveServiceScriptPath('scripts/services/tts-server.sh');
    const configs = new Map([
      ['mlx-tts', { installed: true, enabled: true, selectedModel: 'mlx-community/Kokoro-82M-bf16' }],
    ]);
    const app = await buildApp({
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
      lifecycle: {
        serviceConfig: {
          get: (id) => configs.get(id) ?? { enabled: false },
          set: (id, patch) => {
            const updated = { ...(configs.get(id) ?? { enabled: false }), ...patch };
            configs.set(id, updated);
            return updated;
          },
        },
        findPidsByPort: async (port) => (port === 9879 ? [55852] : []),
        readProcessCommand: async (pid) => (pid === 55852 ? `/bin/bash ${ttsStartScript}` : ''),
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
        },
        runScript: async () => ({ code: 0, output: 'started' }),
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/mlx-tts/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.match(body.message, /already running/i);
      assert.deepEqual(killed, [], 'should NOT kill healthy process');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });
});
