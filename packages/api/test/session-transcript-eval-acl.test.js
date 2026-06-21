/**
 * Session Transcript Eval ACL Tests — F192 eval:sop
 *
 * Verifies that eval cat session read bypass:
 * - Requires VERIFIED callback auth (not just x-cat-id header)
 * - Supports OQ-20 Redis override (dynamic eval cat swap)
 * - Rejects spoofed x-cat-id without callback auth
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

function mockThreadStore(threads = {}) {
  return {
    get: async (id) => threads[id] ?? null,
    list: async () => Object.values(threads),
    create: async () => {},
    update: async () => null,
    delete: async () => false,
  };
}

/**
 * Mock CallbackAuthRegistry that verifies specific invocation/token pairs
 * and returns an InvocationRecord with the given catId.
 */
function mockCallbackRegistry(validEntries = []) {
  // validEntries: [{ invocationId, callbackToken, record }]
  const map = new Map(validEntries.map((e) => [`${e.invocationId}:${e.callbackToken}`, e.record]));
  return {
    verify: async (invocationId, callbackToken) => {
      const record = map.get(`${invocationId}:${callbackToken}`);
      if (record) return { ok: true, record };
      return { ok: false, reason: 'unknown_invocation' };
    },
  };
}

/** Mock Redis that returns JSON for specific keys (for OQ-20 override). */
function mockRedis(kvStore = {}) {
  return { get: async (key) => kvStore[key] ?? null };
}

/**
 * Mock AgentKeyAuthRegistry that verifies specific secrets
 * and returns an AgentKeyRecord with the given catId.
 */
function mockAgentKeyRegistry(validEntries = []) {
  // validEntries: [{ secret, record }]
  const map = new Map(validEntries.map((e) => [e.secret, e.record]));
  return {
    verify: async (secret) => {
      const record = map.get(secret);
      if (record) return { ok: true, record };
      return { ok: false, reason: 'invalid_key' };
    },
  };
}

describe('F192 eval:sop — session transcript eval ACL', () => {
  let app;
  let tmpDir;

  const THREAD = { id: 'thread-1', createdBy: 'user-1' };
  const EVAL_CAT_ID = 'eval-sop-cat';
  const OVERRIDE_CAT_ID = 'override-eval-cat';
  const SESSION_OWNER_CAT = 'opus';

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'eval-acl-'));
  });

  afterEach(async () => {
    if (app) await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(opts = {}) {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { sessionTranscriptRoutes } = await import('../dist/routes/session-transcript.js');

    const sessionChainStore = new SessionChainStore();
    const threadStore = mockThreadStore({ 'thread-1': THREAD });
    const transcriptReader = new TranscriptReader({ dataDir: tmpDir });
    const writer = new TranscriptWriter({ dataDir: tmpDir });

    // Default: eval cat in static set, with callback registry that verifies it
    const evalCatIds = opts.evalCatIds ?? new Set([EVAL_CAT_ID]);
    const evalDomainIds = opts.evalDomainIds ?? ['eval:sop'];
    const redis = opts.redis ?? undefined;

    const callbackRegistry =
      opts.callbackRegistry ??
      mockCallbackRegistry([
        {
          invocationId: 'inv-eval-1',
          callbackToken: 'tok-eval-1',
          record: {
            invocationId: 'inv-eval-1',
            threadId: 'thread-1',
            catId: EVAL_CAT_ID,
            userId: 'user-1',
            createdAt: Date.now(),
          },
        },
      ]);

    const agentKeyRegistry = opts.agentKeyRegistry ?? undefined;

    app = Fastify();
    await app.register(sessionTranscriptRoutes, {
      sessionChainStore,
      threadStore,
      transcriptReader,
      evalCatIds,
      evalDomainIds,
      redis,
      callbackRegistry,
      agentKeyRegistry,
    });
    await app.ready();

    return { sessionChainStore, writer, transcriptReader };
  }

  async function createSession(sessionChainStore, writer, catId = SESSION_OWNER_CAT) {
    const record = sessionChainStore.create({
      cliSessionId: 'cli-1',
      threadId: 'thread-1',
      catId,
      userId: 'user-1',
    });
    const sessInfo = {
      sessionId: record.id,
      threadId: 'thread-1',
      catId,
      cliSessionId: 'cli-1',
      seq: 0,
    };
    writer.appendEvent(sessInfo, { type: 'user', content: [{ type: 'text', text: 'Hello' }] }, 'inv-1');
    writer.appendEvent(sessInfo, { type: 'assistant', content: [{ type: 'text', text: 'Hi' }] }, 'inv-1');
    sessionChainStore.update(record.id, { status: 'sealed' });
    await writer.flush(sessInfo, { createdAt: 1000, sealedAt: 2000 });
    return record;
  }

  // --- P1: x-cat-id spoofing prevention ---

  it('rejects cross-cat read with ONLY x-cat-id header (no callback auth)', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    // Attacker sends x-cat-id claiming to be eval cat, but no callback creds
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID, // spoofed — not verified
      },
    });
    // Session belongs to 'opus', caller claims 'eval-sop-cat' without proof → 403
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Access denied'));
  });

  // --- P1: verified callback auth allows cross-cat read ---

  it('allows cross-cat read with verified callback auth (static eval cat)', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    // Eval cat sends both x-cat-id AND valid callback creds → verified
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID,
        'x-invocation-id': 'inv-eval-1',
        'x-callback-token': 'tok-eval-1',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
  });

  // --- P1: OQ-20 Redis override support ---

  it('allows cross-cat read for OQ-20 Redis override eval cat', async () => {
    // Redis returns override entry mapping OVERRIDE_CAT_ID to eval:sop domain
    const redisData = {
      'eval-domain:eval:sop:evalCat-override': JSON.stringify({
        catId: OVERRIDE_CAT_ID,
        handle: 'override-cat',
        model: 'test-model',
        setAt: new Date().toISOString(),
      }),
    };

    const callbackRegistry = mockCallbackRegistry([
      {
        invocationId: 'inv-override-1',
        callbackToken: 'tok-override-1',
        record: {
          invocationId: 'inv-override-1',
          threadId: 'thread-1',
          catId: OVERRIDE_CAT_ID,
          userId: 'user-1',
          createdAt: Date.now(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({
      evalCatIds: new Set([EVAL_CAT_ID]), // override cat NOT in static set
      evalDomainIds: ['eval:sop'],
      redis: mockRedis(redisData),
      callbackRegistry,
    });
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': OVERRIDE_CAT_ID,
        'x-invocation-id': 'inv-override-1',
        'x-callback-token': 'tok-override-1',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
  });

  // --- Same-cat access still works without callback auth ---

  it('allows same-cat read without callback auth (x-cat-id matches session)', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': SESSION_OWNER_CAT, // matches session catId
      },
    });
    assert.equal(res.statusCode, 200);
  });

  // --- Agent-key ACL hardening (resolveCallerCatId picks up callbackPrincipal) ---

  it('rejects agent-key caller reading another cat session (no x-cat-id header)', async () => {
    const ATTACKER_CAT = 'attacker-cat';
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-attacker',
        record: {
          agentKeyId: 'ak-1',
          catId: ATTACKER_CAT,
          userId: 'user-1',
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    const record = await createSession(sessionChainStore, writer); // owned by SESSION_OWNER_CAT='opus'

    // Agent-key caller with catId='attacker-cat', NO x-cat-id header
    // resolveCallerCatId should pick up callbackPrincipal.catId → 403
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-attacker',
        // deliberately NO x-cat-id — testing that principal.catId is used
      },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Access denied'));
  });

  it('allows agent-key caller reading own session (catId matches)', async () => {
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-opus',
        record: {
          agentKeyId: 'ak-2',
          catId: SESSION_OWNER_CAT, // 'opus' — matches session owner
          userId: 'user-1',
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-opus',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
  });

  // --- Agent-key eval cat positive path (isVerifiedEvalCat reads callbackPrincipal) ---

  it('allows agent-key eval cat to cross-cat read (static eval set)', async () => {
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-eval',
        record: {
          agentKeyId: 'ak-eval-1',
          catId: EVAL_CAT_ID, // in static evalCatIds set
          userId: 'user-1',
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    const record = await createSession(sessionChainStore, writer); // owned by 'opus'

    // Agent-key eval cat reads another cat's session → should succeed (not 403)
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-eval',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
  });

  it('allows agent-key eval cat to cross-cat read (OQ-20 Redis override)', async () => {
    const redisData = {
      'eval-domain:eval:sop:evalCat-override': JSON.stringify({
        catId: OVERRIDE_CAT_ID,
        handle: 'override-cat',
        model: 'test-model',
        setAt: new Date().toISOString(),
      }),
    };

    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-override-eval',
        record: {
          agentKeyId: 'ak-eval-2',
          catId: OVERRIDE_CAT_ID, // NOT in static set, but in Redis override
          userId: 'user-1',
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({
      evalCatIds: new Set([EVAL_CAT_ID]), // override NOT in static set
      evalDomainIds: ['eval:sop'],
      redis: mockRedis(redisData),
      agentKeyRegistry,
    });
    const record = await createSession(sessionChainStore, writer); // owned by 'opus'

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-override-eval',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
  });

  // --- Digest endpoint uses same verified auth ---

  it('digest: rejects spoofed x-cat-id without callback auth', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/digest`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID,
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('digest: allows verified eval cat cross-cat read', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/digest`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID,
        'x-invocation-id': 'inv-eval-1',
        'x-callback-token': 'tok-eval-1',
      },
    });
    // Digest may be 200 or 404 (if digest file missing) — but NOT 403
    assert.notEqual(res.statusCode, 403);
  });

  // --- Search endpoint uses verified auth for cat filter bypass ---

  it('search: spoofed eval cat header gets force-filtered to own sessions', async () => {
    const { sessionChainStore, writer } = await setup();
    await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search?q=hello`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID, // spoofed, no callback creds
      },
    });
    // Should succeed but results are force-filtered to caller's cat only
    assert.equal(res.statusCode, 200);
  });

  // --- Search route uses resolveCallerCatId (agent-key identity) ---

  it('search: agent-key caller gets force-filtered by resolved catId', async () => {
    const ATTACKER_CAT = 'attacker-cat';
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-attacker',
        record: {
          agentKeyId: 'ak-3',
          catId: ATTACKER_CAT,
          userId: 'user-1',
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    await createSession(sessionChainStore, writer); // owned by 'opus'

    // Agent-key caller is not eval cat → search should be force-filtered to 'attacker-cat'
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search?q=hello`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-attacker',
        // No x-cat-id header — resolveCallerCatId picks up principal.catId
      },
    });
    assert.equal(res.statusCode, 200);
    // Results filtered to attacker-cat's sessions (which has none) — no data leak
  });

  // --- userId binding: verified principal userId prevents cross-user read ---

  it('rejects cross-user read when agent-key userId differs from thread owner', async () => {
    const OTHER_USER_CAT = 'other-user-cat';
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-other-user',
        record: {
          agentKeyId: 'ak-4',
          catId: OTHER_USER_CAT,
          userId: 'user-2', // different from thread owner 'user-1'
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    const record = await createSession(sessionChainStore, writer);

    // Agent-key with userId='user-2' tries to read session in thread owned by 'user-1'
    // The spoofed x-cat-cafe-user='user-1' should be OVERRIDDEN by principal.userId='user-2'
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1', // spoofed — should be overridden
        'x-agent-key-secret': 'ak-secret-other-user',
      },
    });
    // resolveVerifiedUserId returns 'user-2' → canAccessSessionThread fails → 403
    assert.equal(res.statusCode, 403);
  });

  it('allows same-user read when agent-key userId matches thread owner', async () => {
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-user1',
        record: {
          agentKeyId: 'ak-5',
          catId: SESSION_OWNER_CAT,
          userId: 'user-1', // matches thread owner
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-user1',
      },
    });
    assert.equal(res.statusCode, 200);
  });

  // --- P2: Invocation endpoint eval ACL (positive + negative) ---

  it('invocation: rejects spoofed x-cat-id cross-cat read (no callback auth)', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-1`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID, // spoofed
      },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Access denied'));
  });

  it('invocation: allows verified eval cat cross-cat read', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-1`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID,
        'x-invocation-id': 'inv-eval-1',
        'x-callback-token': 'tok-eval-1',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.invocationId, 'inv-1');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0, 'expected at least 1 event for inv-1');
    assert.equal(body.total, body.events.length);
  });

  it('invocation: allows agent-key eval cat cross-cat read', async () => {
    const agentKeyRegistry = mockAgentKeyRegistry([
      {
        secret: 'ak-secret-eval-inv',
        record: {
          agentKeyId: 'ak-eval-inv',
          catId: EVAL_CAT_ID,
          userId: 'user-1',
          secretHash: 'irrelevant',
          salt: 'irrelevant',
          scope: 'user-bound',
          issuedAt: new Date().toISOString(),
        },
      },
    ]);

    const { sessionChainStore, writer } = await setup({ agentKeyRegistry });
    const record = await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-1`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-agent-key-secret': 'ak-secret-eval-inv',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.invocationId, 'inv-1');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0, 'expected at least 1 event for inv-1');
    assert.equal(body.total, body.events.length);
  });

  // --- P2: Search endpoint — scope assertion (verify force-filter works) ---

  it('search: non-eval cat results are limited to own sessions only', async () => {
    const { sessionChainStore, writer } = await setup();
    // Create session owned by 'opus'
    await createSession(sessionChainStore, writer, SESSION_OWNER_CAT);

    // Search as 'other-cat' (not eval) — should get 200 but no hits from opus sessions
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search?q=Hello`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': 'other-cat', // not eval, not session owner
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Force-filtered to 'other-cat' sessions which has none — hits must be empty
    assert.ok(Array.isArray(body.hits));
    assert.equal(body.hits.length, 0);
  });

  it('search: verified eval cat can see cross-cat results', async () => {
    const { sessionChainStore, writer } = await setup();
    // Create session owned by 'opus' with searchable content ("Hello")
    await createSession(sessionChainStore, writer, SESSION_OWNER_CAT);

    // Search as verified eval cat — should NOT be force-filtered
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search?q=Hello`,
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': EVAL_CAT_ID,
        'x-invocation-id': 'inv-eval-1',
        'x-callback-token': 'tok-eval-1',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.hits));
    // Eval cat is exempt from force-filter → sees opus's session content containing "Hello"
    assert.ok(body.hits.length > 0, 'eval cat bypass must produce hits (non-eval same query gets 0)');
  });

  // --- P2: Search schema validation ---

  it('search: rejects missing query parameter', async () => {
    const { sessionChainStore, writer } = await setup();
    await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  it('search: accepts valid scope parameter', async () => {
    const { sessionChainStore, writer } = await setup();
    await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search?q=test&scope=digests`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('search: rejects invalid scope parameter', async () => {
    const { sessionChainStore, writer } = await setup();
    await createSession(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/thread-1/sessions/search?q=test&scope=invalid`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 400);
  });
});
