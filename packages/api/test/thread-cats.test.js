/**
 * GET /api/threads/:id/cats — thread cat categorization API (F142)
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

function stubThreadStore(threads = new Map(), participants = new Map()) {
  return {
    get: async (id) => threads.get(id) ?? null,
    getParticipantsWithActivity: async (id) => participants.get(id) ?? [],
  };
}

function stubBindingStore(bindings = new Map()) {
  return {
    getByThread: async (threadId) => bindings.get(threadId) ?? [],
  };
}

function stubCatDeps({ roster = {}, services = new Map(), available = {} } = {}) {
  return {
    getCatDisplayName: (catId) => roster[catId]?.displayName ?? catId,
    getAllCatIds: () => Object.keys(roster),
    isCatAvailable: (catId) => available[catId] !== false,
    agentRegistry: { getAllEntries: () => services },
  };
}

describe('GET /api/threads/:id/cats', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function setup({ threads, participants, bindings, roster, services, available } = {}) {
    const { threadCatsRoutes } = await import('../dist/routes/thread-cats.js');
    app = Fastify();
    await app.register(threadCatsRoutes, {
      threadStore: stubThreadStore(threads, participants),
      bindingStore: stubBindingStore(bindings),
      ...stubCatDeps({ roster, services, available }),
    });
    await app.ready();
    return app;
  }

  it('returns 404 for non-existent thread', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t-nonexistent/cats',
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 401 when thread has bindings but no auth header', async () => {
    const threads = new Map([['t-bound', { id: 't-bound' }]]);
    const bindings = new Map([['t-bound', [{ userId: 'owner' }]]]);
    await setup({ threads, bindings });
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t-bound/cats',
      // no x-cat-cafe-user header
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when user is not binding owner (AC-A6)', async () => {
    const threads = new Map([['t-bound', { id: 't-bound' }]]);
    const bindings = new Map([['t-bound', [{ userId: 'owner' }]]]);
    await setup({ threads, bindings });
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t-bound/cats',
      headers: { 'x-cat-cafe-user': 'wrong-user' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('allows binding owner access', async () => {
    const threads = new Map([['t-bound', { id: 't-bound' }]]);
    const bindings = new Map([['t-bound', [{ userId: 'owner' }]]]);
    await setup({ threads, bindings, roster: {} });
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t-bound/cats',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('allows unauthenticated access for hub-only threads (no bindings)', async () => {
    const threads = new Map([['t-hub', { id: 't-hub' }]]);
    await setup({ threads, roster: {} });
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t-hub/cats',
      // no auth header, no bindings → allowed
    });
    assert.equal(res.statusCode, 200);
  });

  it('snapshot: cat categorization matches AgentRouter logic (AC-A7)', async () => {
    // Setup: 4 cats
    // - opus: participant + service + available → participants ✅ + routableNow ✅
    // - codex: participant + service + available=false → participants ✅ only
    //          (participants always listed regardless of availability;
    //           notRoutable excludes participants — they're already visible)
    // - gpt52: not participant + service + available → routableNotJoined ✅
    // - gemini: not participant + available=false → notRoutable ✅ (KD-9)
    const threads = new Map([['t-snap', { id: 't-snap' }]]);
    const participants = new Map([
      [
        't-snap',
        [
          { catId: 'opus', lastMessageAt: 1000, messageCount: 5 },
          { catId: 'codex', lastMessageAt: 800, messageCount: 3 },
        ],
      ],
    ]);
    const roster = {
      opus: { displayName: '布偶猫' },
      codex: { displayName: '缅因猫' },
      gpt52: { displayName: 'GPT-5.4' },
      gemini: { displayName: '暹罗猫' },
    };
    const services = new Map([
      ['opus', {}],
      ['codex', {}],
      ['gpt52', {}],
    ]);
    const available = { opus: true, codex: false, gpt52: true, gemini: false };

    await setup({ threads, participants, roster, services, available });
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t-snap/cats',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.participants.length, 2); // opus + codex
    assert.equal(body.routableNow.length, 1); // opus (participant + routable)
    assert.equal(body.routableNotJoined.length, 1); // gpt52 (not participant + routable)
    assert.equal(body.notRoutable.length, 1); // gemini (not participant + available=false)

    // Verify specific assignments
    assert.equal(body.routableNow[0].catId, 'opus');
    assert.equal(body.routableNotJoined[0].catId, 'gpt52');
    assert.equal(body.notRoutable[0].catId, 'gemini');

    // codex is unavailable but a participant — NOT in notRoutable
    const notRoutableIds = body.notRoutable.map((c) => c.catId);
    assert.ok(!notRoutableIds.includes('codex'));
  });

  it('returns display names from getCatDisplayName', async () => {
    const threads = new Map([['t-dn', { id: 't-dn' }]]);
    const participants = new Map([['t-dn', [{ catId: 'opus', lastMessageAt: 1000, messageCount: 1 }]]]);
    const roster = { opus: { displayName: '布偶猫 Opus' } };
    const services = new Map([['opus', {}]]);
    await setup({ threads, participants, roster, services });
    const res = await app.inject({ method: 'GET', url: '/api/threads/t-dn/cats' });
    const body = JSON.parse(res.body);
    assert.equal(body.participants[0].displayName, '布偶猫 Opus');
  });
});
