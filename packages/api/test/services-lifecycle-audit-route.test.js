import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
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

describe('service lifecycle audit route', () => {
  it('exposes lifecycle audit events through an owner-gated metadata-only endpoint', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const events = [];
    const auditLog = {
      append: async (input) => {
        const event = {
          id: `audit-${events.length + 1}`,
          timestamp: Date.now() + events.length,
          ...input,
        };
        events.push(event);
        return event;
      },
      readByType: async (type) => events.filter((event) => event.type === type).reverse(),
      listFiles: async () => ['audit-test.ndjson'],
    };
    const app = await buildApp({
      lifecycle: {
        auditLog,
        findPidsByPort: async () => [],
        runScript: async () => ({ code: 0, output: 'RAW_SCRIPT_OUTPUT_SHOULD_NOT_LEAK' }),
      },
    });
    try {
      const write = await app.inject({
        method: 'POST',
        url: '/api/services/whisper-stt/start',
        headers: SESSION_HEADERS,
      });
      assert.equal(write.statusCode, 200, write.payload);

      const audit = await app.inject({
        method: 'GET',
        url: '/api/services/audit',
        headers: SESSION_HEADERS,
      });

      assert.equal(audit.statusCode, 200, audit.payload);
      const body = JSON.parse(audit.payload);
      assert.deepEqual(body.logFiles, ['audit-test.ndjson']);
      assert.equal(body.events.length, 2);
      assert.deepEqual(body.events[0].data, {
        serviceId: 'whisper-stt',
        action: 'start',
        operator: 'you',
        status: 'completed',
        code: 0,
      });
      assert.equal(JSON.stringify(body).includes('scriptPath'), false);
      assert.equal(JSON.stringify(body).includes('RAW_SCRIPT_OUTPUT_SHOULD_NOT_LEAK'), false);
    } finally {
      await app.close();
      restoreOwner(previousOwner);
    }
  });

  it('fails closed when service audit is read without the configured owner session', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const app = await buildApp();
    try {
      const missingSession = await app.inject({ method: 'GET', url: '/api/services/audit' });
      assert.equal(missingSession.statusCode, 401, missingSession.payload);

      const wrongOwner = await app.inject({
        method: 'GET',
        url: '/api/services/audit',
        headers: { 'x-test-session-user': 'bob' },
      });
      assert.equal(wrongOwner.statusCode, 403, wrongOwner.payload);
    } finally {
      await app.close();
      restoreOwner(ORIGINAL_OWNER_ID);
    }
  });
});
