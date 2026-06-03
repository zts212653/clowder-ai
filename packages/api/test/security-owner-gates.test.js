import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { f163AdminRoutes } = await import('../dist/routes/f163-admin.js');
const { promptCaptureRoutes } = await import('../dist/routes/prompt-captures.js');

const ORIGINAL_OWNER_ID = process.env.DEFAULT_OWNER_USER_ID;
const ORIGINAL_F163_COMPRESSION = process.env.F163_COMPRESSION;

function restoreEnv() {
  if (ORIGINAL_OWNER_ID === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;

  if (ORIGINAL_F163_COMPRESSION === undefined) delete process.env.F163_COMPRESSION;
  else process.env.F163_COMPRESSION = ORIGINAL_F163_COMPRESSION;
}

function installTestSessionHook(app) {
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
}

function createEvidenceStore() {
  const docs = new Map([
    [
      'summary-anchor',
      {
        anchor: 'summary-anchor',
        authority: 'validated',
        title: 'Sensitive summary',
        summary: 'Summary that expands into source prompt evidence',
      },
    ],
    [
      'source-a',
      {
        anchor: 'source-a',
        authority: 'observed',
        title: 'Source A',
        summary: 'Sensitive source payload',
      },
    ],
    ['promote-anchor', { anchor: 'promote-anchor', authority: 'observed' }],
  ]);

  const db = {
    prepare(sql) {
      return {
        all() {
          if (sql.includes('SELECT source_ids, summary_of_anchor')) {
            return [{ source_ids: JSON.stringify(['source-a']), summary_of_anchor: 'summary-anchor' }];
          }
          return [];
        },
        run() {
          return { changes: 1 };
        },
      };
    },
  };

  return {
    getByAnchor: async (anchor) => docs.get(anchor) ?? null,
    getDb: () => db,
    runExclusive: async (fn) => fn(),
    createSummary: async () => 'summary-new',
  };
}

async function buildF163App() {
  const app = Fastify({ logger: false });
  installTestSessionHook(app);
  await app.register(f163AdminRoutes, { evidenceStore: createEvidenceStore() });
  await app.ready();
  return app;
}

async function buildPromptCaptureApp() {
  const app = Fastify({ logger: false });
  installTestSessionHook(app);
  await app.register(promptCaptureRoutes);
  await app.ready();
  return app;
}

afterEach(() => {
  restoreEnv();
});

describe('security owner/network gates for #835 surfaces', () => {
  it('rejects unauthenticated F163 expand reads', async () => {
    const app = await buildF163App();
    const res = await app.inject({ method: 'GET', url: '/api/f163/expand/summary-anchor' });

    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /session/i);
    await app.close();
  });

  it('allows F163 expand for configured owner sessions', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const app = await buildF163App();
    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/expand/summary-anchor',
      headers: { 'x-test-session-user': 'owner-1' },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().summary.anchor, 'summary-anchor');
    await app.close();
  });

  it('rejects proxied privileged routes when owner is the public default session user', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';
    const app = await buildF163App();
    const res = await app.inject({
      method: 'GET',
      url: '/api/f163/expand/summary-anchor',
      headers: {
        'x-test-session-user': 'default-user',
        'x-forwarded-for': '192.168.1.23',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /localhost/i);
    await app.close();
  });

  it('rejects proxied F163 promote writes when no owner is configured', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const app = await buildF163App();
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/promote',
      headers: {
        'x-test-session-user': 'default-user',
        'x-forwarded-for': '192.168.1.23',
      },
      payload: {
        anchor: 'promote-anchor',
        targetAuthority: 'candidate',
        reason: 'test promotion',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /DEFAULT_OWNER_USER_ID/);
    await app.close();
  });

  it('rejects proxied F163 compression scan when no owner is configured', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    process.env.F163_COMPRESSION = 'suggest';
    const app = await buildF163App();
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/scan',
      headers: {
        'x-test-session-user': 'default-user',
        'x-forwarded-for': '192.168.1.23',
      },
      payload: { threshold: 0.75 },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /DEFAULT_OWNER_USER_ID/);
    await app.close();
  });

  it('rejects proxied F163 compression apply when no owner is configured', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    process.env.F163_COMPRESSION = 'apply';
    const app = await buildF163App();
    const res = await app.inject({
      method: 'POST',
      url: '/api/f163/compress/apply',
      headers: {
        'x-test-session-user': 'default-user',
        'x-forwarded-for': '192.168.1.23',
      },
      payload: {
        sourceAnchors: ['source-a', 'source-b'],
        summaryTitle: 'summary',
        summarySummary: 'summary body',
        rationale: 'test compression',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /DEFAULT_OWNER_USER_ID/);
    await app.close();
  });

  it('rejects prompt-capture debug reads for non-owner sessions', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const app = await buildPromptCaptureApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/prompt-captures/status',
      headers: { 'x-test-session-user': 'not-owner' },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /owner/i);
    await app.close();
  });

  it('rejects proxied prompt-capture debug reads when no owner is configured', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const app = await buildPromptCaptureApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/prompt-captures/status',
      headers: {
        'x-test-session-user': 'default-user',
        'x-forwarded-for': '192.168.1.23',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /DEFAULT_OWNER_USER_ID/);
    await app.close();
  });
});
