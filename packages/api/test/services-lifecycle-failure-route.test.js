import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { resolveServiceScriptPath } from '../dist/domains/services/service-lifecycle.js';
import { servicesRoutes } from '../dist/routes/services.js';

const SESSION_HEADERS = { 'x-test-session-user': 'you' };
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

function createAuditLog() {
  const events = [];
  return {
    events,
    auditLog: {
      append: async (input) => {
        events.push(input);
        return input;
      },
      readByType: async (type) => events.filter((event) => event.type === type),
    },
  };
}

describe('service lifecycle failure handling', () => {
  it('fails closed and audits when the service port probe is unavailable', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog, events } = createAuditLog();
    let didRun = false;
    const app = await buildApp({
      lifecycle: {
        auditLog,
        findPidsByPort: async () => {
          throw new Error('lsof unavailable');
        },
        runScript: async () => {
          didRun = true;
          return { code: 0, output: 'started' };
        },
      },
    });
    try {
      const start = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(start.statusCode, 503, start.payload);
      assert.match(JSON.parse(start.payload).error, /port probe/i);
      assert.equal(didRun, false);

      const stop = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/stop',
        headers: SESSION_HEADERS,
      });
      assert.equal(stop.statusCode, 503, stop.payload);
      assert.match(JSON.parse(stop.payload).error, /port probe/i);

      assert.deepEqual(
        events.map((event) => event.data),
        [
          {
            serviceId: 'whisper-stt',
            action: 'start',
            operator: 'you',
            status: 'rejected',
            reason: 'port-probe-unavailable',
          },
          {
            serviceId: 'whisper-stt',
            action: 'stop',
            operator: 'you',
            status: 'rejected',
            reason: 'port-probe-unavailable',
          },
        ],
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('returns a controlled failure and audits install runner exceptions', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog, events } = createAuditLog();
    const app = await buildApp({
      lifecycle: {
        auditLog,
        runScript: async () => {
          throw new Error('spawn ENOENT /private/raw/script/path');
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

      assert.equal(res.statusCode, 502, res.payload);
      assert.match(JSON.parse(res.payload).error, /runner failed/i);
      assert.equal(res.payload.includes('ENOENT'), false);
      assert.equal(res.payload.includes('/private/raw/script/path'), false);
      assert.deepEqual(
        events.map((event) => event.data.status),
        ['started', 'failed'],
      );
      assert.equal(events.at(-1).data.reason, 'runner-error');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('returns a controlled failure and audits start runner exceptions', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog, events } = createAuditLog();
    const app = await buildApp({
      lifecycle: {
        auditLog,
        findPidsByPort: async () => [],
        runScript: async () => {
          throw new Error('spawn ENOENT /private/raw/start/path');
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 502, res.payload);
      assert.match(JSON.parse(res.payload).error, /runner failed/i);
      assert.equal(res.payload.includes('ENOENT'), false);
      assert.equal(res.payload.includes('/private/raw/start/path'), false);
      assert.deepEqual(
        events.map((event) => event.data.status),
        ['started', 'failed'],
      );
      assert.equal(events.at(-1).data.reason, 'runner-error');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('keeps the service lock during detached startup grace', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    let runCount = 0;
    const app = await buildApp({
      lifecycle: {
        timeoutMs: 50,
        startupGraceMs: 50,
        findPidsByPort: async () => [],
        runScript: async () => {
          runCount += 1;
          return { code: null, pid: 7000 + runCount };
        },
      },
    });
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(first.statusCode, 200, first.payload);

      const second = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(second.statusCode, 409, second.payload);
      assert.equal(runCount, 1);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('treats an owned listener as already running instead of invoking start again', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog, events } = createAuditLog();
    let didRun = false;
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const app = await buildApp({
      lifecycle: {
        auditLog,
        findPidsByPort: async () => [5151],
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
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

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(didRun, false);
      assert.deepEqual(JSON.parse(res.payload), {
        ok: true,
        message: 'Whisper STT is already running',
        pids: [5151],
      });
      assert.deepEqual(
        events.map((event) => event.data),
        [
          {
            serviceId: 'whisper-stt',
            action: 'start',
            operator: 'you',
            status: 'completed',
            reason: 'already-running',
          },
        ],
      );
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('surfaces stop failures when signaling an owned process fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog, events } = createAuditLog();
    const killed = [];
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const app = await buildApp({
      lifecycle: {
        auditLog,
        findPidsByPort: async () => [5151],
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
        killPid: (pid, signal) => {
          killed.push({ pid, signal });
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        },
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/stop',
        headers: SESSION_HEADERS,
      });

      assert.equal(res.statusCode, 502, res.payload);
      assert.deepEqual(killed, [{ pid: 5151, signal: 'SIGTERM' }]);
      assert.deepEqual(JSON.parse(res.payload), {
        ok: false,
        error: 'Whisper STT stop failed for 1 process(es)',
        stopped: [],
        failed: [5151],
      });
      assert.equal(events.at(-1).data.status, 'failed');
      assert.equal(events.at(-1).data.reason, 'terminate-failed');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('treats ESRCH during stop as an already-exited owned process', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const { auditLog, events } = createAuditLog();
    const resolvedScript = resolveServiceScriptPath('scripts/services/whisper-server.sh');
    const app = await buildApp({
      lifecycle: {
        auditLog,
        findPidsByPort: async () => [5151],
        readProcessCommand: async () => `/bin/bash ${resolvedScript}`,
        killPid: () => {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
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
      assert.deepEqual(JSON.parse(res.payload), {
        ok: true,
        message: 'Whisper STT stopped (0 process(es))',
        stopped: [],
      });
      assert.equal(events.at(-1).data.status, 'completed');
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });
});
