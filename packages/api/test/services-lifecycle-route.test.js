import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  isServiceProcessCommand,
  resolveServiceScriptPath,
  runServiceScript,
} from '../dist/domains/services/service-lifecycle.js';
import { servicesRoutes } from '../dist/routes/services.js';

const SESSION_HEADERS = { 'x-test-session-user': 'you' };
const TRUSTED_ORIGIN_HEADERS = { origin: 'http://localhost:3003', host: 'localhost:3003' };
const ORIGINAL_OWNER_ID = process.env.DEFAULT_OWNER_USER_ID;

async function buildApp(options = {}) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(servicesRoutes, {
    ...options,
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

  it('fails closed for lifecycle writes when DEFAULT_OWNER_USER_ID is missing', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/install',
        headers: SESSION_HEADERS,
        payload: { model: 'mlx-community/whisper-large-v3-turbo' },
      });

      assert.equal(res.statusCode, 403, res.payload);
      assert.match(JSON.parse(res.payload).error, /DEFAULT_OWNER_USER_ID/);
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
      assert.match(JSON.parse(res.payload).error, /DEFAULT_OWNER_USER_ID/);
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
    const app = await buildApp({
      lifecycle: {
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

  it('refuses to start when the service port belongs to another process', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let didRun = false;
    const app = await buildApp({
      lifecycle: {
        findPidsByPort: async () => [4242],
        readProcessCommand: async () => 'python unrelated-server.py --port 9876',
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

  it('keeps service script paths inside the repository services directory', () => {
    assert.match(
      resolveServiceScriptPath('scripts/services/whisper-install.sh'),
      /scripts\/services\/whisper-install\.sh$/,
    );
    assert.throws(() => resolveServiceScriptPath('../cat-cafe-runtime/.env'), /outside/i);
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
