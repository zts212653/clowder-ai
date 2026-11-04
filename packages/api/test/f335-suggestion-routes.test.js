import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { registerSuggestionRoutes } from '../dist/routes/suggestion-routes.js';

/** Each case explicitly configures the owner whose decision boundary it exercises. */
const USER = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
const THREAD = 'thread_watch';

function handler(kind) {
  return {
    kind,
    kindLabel: '添加视频批注',
    undoLabel: 'undo',
    prepare: async (_ctx, params) => ({ ok: true, value: params }),
    apply: async () => ({ ok: true, value: { appliedRef: { ok: 1 }, receipt: { text: '已添加 7 条批注' } } }),
    undo: async () => ({ ok: true, value: undefined }),
  };
}

describe('F335 suggestion routes', () => {
  let app;
  let auth;
  let broadcasts;
  let originalOwner;

  beforeEach(async () => {
    originalOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = USER;
    broadcasts = [];
    const registry = new InvocationRegistry();
    auth = await registry.create(USER, 'codex61-sol', THREAD);
    const messages = new Map([['msg-282', { userId: USER, threadId: THREAD }]]);
    const suggestions = createSuggestionIntegration({
      messageStore: { getById: (id) => messages.get(id) ?? null },
      invocationTracker: {
        getLifecycleResponseMessageId: (_t, _c, invocationId) =>
          invocationId === auth.invocationId ? 'msg-turn' : undefined,
      },
      socketManager: { broadcastToRoom: (room, event, data) => broadcasts.push({ room, event, data }) },
    });
    suggestions.registry.register(handler('video-comments'));
    app = Fastify();
    // The session issuer sets `sessionUserId` from the cookie in production; the fixture stands in for it.
    app.addHook('onRequest', async (request) => {
      const session = request.headers['x-fixture-session'];
      if (typeof session === 'string') request.sessionUserId = session;
    });
    await app.register(async (scope) => {
      registerSuggestionRoutes(scope, {
        service: suggestions.service,
        desk: suggestions.desk,
        callbackRegistry: registry,
        resolveByline: (actor) => (actor.catId === 'codex61-sol' ? 'watcher' : 'cat'),
      });
    });
  });

  afterEach(async () => {
    if (originalOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = originalOwner;
    await app?.close();
  });

  const cat = () => ({ 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken });
  const person = { 'x-fixture-session': USER };
  const offer = (payload) => app.inject({ method: 'POST', url: '/api/callbacks/suggestions', headers: cat(), payload });

  it('lets a cat offer under its turn’s reply or a named message, and pushes the row to the room', async () => {
    const own = await offer({ label: '添加 7 条视频批注', action: { kind: 'video-comments', params: {} } });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().messageId, 'msg-turn');
    assert.equal(own.json().byline, 'watcher');
    const named = await offer({ messageId: 'msg-282', label: 'x', action: { kind: 'video-comments', params: {} } });
    assert.equal(named.json().messageId, 'msg-282');
    assert.deepEqual(
      broadcasts.map((b) => [b.room, b.event]),
      [
        [`thread:${THREAD}`, 'suggestion_updated'],
        [`thread:${THREAD}`, 'suggestion_updated'],
      ],
    );
    const dup = await offer({ messageId: 'msg-282', label: 'x', action: { kind: 'video-comments', params: {} } });
    assert.equal(dup.statusCode, 409);
    const unknown = await offer({ messageId: 'msg-282', label: 'x', action: { kind: 'buy', params: {} } });
    assert.equal(unknown.statusCode, 400);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/suggestions',
      headers: { ...cat(), 'x-callback-token': 'nope' },
      payload: { label: 'x', action: { kind: 'video-comments', params: {} } },
    });
    assert.equal(forged.statusCode, 401);
  });

  it('lets the person list, apply and undo — applying only from this machine', async () => {
    const offered = (
      await offer({ label: '添加 7 条视频批注', action: { kind: 'video-comments', params: {} } })
    ).json();
    assert.equal((await app.inject({ method: 'GET', url: `/api/threads/${THREAD}/suggestions` })).statusCode, 401);
    const listed = await app.inject({ method: 'GET', url: `/api/threads/${THREAD}/suggestions`, headers: person });
    assert.deepEqual(
      listed.json().suggestions.map((row) => row.id),
      [offered.id],
    );

    const remote = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${offered.id}/apply`,
      headers: person,
      remoteAddress: '10.0.0.8',
      payload: { expectedRevision: offered.revision },
    });
    assert.equal(remote.statusCode, 403, 'writing as the person needs the same local identity as the Works page');

    const applied = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${offered.id}/apply`,
      headers: person,
      payload: { expectedRevision: offered.revision },
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().state, 'applied');
    const stale = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${offered.id}/undo`,
      headers: person,
      payload: { expectedRevision: offered.revision },
    });
    assert.equal(stale.statusCode, 409);
    const undone = await app.inject({
      method: 'POST',
      url: `/api/suggestions/${offered.id}/undo`,
      headers: person,
      payload: { expectedRevision: applied.json().revision },
    });
    assert.equal(undone.json().state, 'open');
  });

  it('never lets a cat, a bare identity header, or another machine decide for the person', async () => {
    const offered = (await offer({ label: '创建定时任务', action: { kind: 'video-comments', params: {} } })).json();
    const decide = (verb, headers, extra = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/suggestions/${offered.id}/${verb}`,
        headers,
        payload: { expectedRevision: offered.revision },
        ...extra,
      });
    for (const verb of ['apply', 'undo', 'dismiss']) {
      assert.equal((await decide(verb, { ...cat(), ...person })).statusCode, 403, `${verb}: a cat with a session too`);
      assert.equal((await decide(verb, cat())).statusCode, 403, `${verb}: a cat alone`);
      assert.equal((await decide(verb, { 'x-cat-cafe-user': USER })).statusCode, 401, `${verb}: header, no session`);
    }
    const unverified = await decide('apply', { ...person, 'x-callback-token': 'stale' });
    assert.ok([401, 403].includes(unverified.statusCode), 'any cat credential, even an unverified one, is refused');
    assert.equal((await decide('apply', { 'x-fixture-session': 'someone-else' })).statusCode, 403, 'not the owner');
    assert.equal((await decide('apply', person, { remoteAddress: '10.0.0.8' })).statusCode, 403);
    const listByHeader = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD}/suggestions`,
      headers: { 'x-cat-cafe-user': USER },
    });
    assert.equal(listByHeader.statusCode, 401);
    const stillOpen = await app.inject({ method: 'GET', url: `/api/threads/${THREAD}/suggestions`, headers: person });
    assert.equal(stillOpen.json().suggestions[0].state, 'open', 'nothing above changed the row');
  });

  it('gives cats facts and lets the person restore a kind a cat stopped offering', async () => {
    const facts = await app.inject({
      method: 'POST',
      url: '/api/callbacks/suggestion-facts',
      headers: cat(),
      payload: { stopOffering: 'video-comments' },
    });
    assert.equal(facts.statusCode, 200);
    assert.equal(facts.json().stopped, 'video-comments');
    const hidden = await app.inject({ method: 'GET', url: '/api/suggestions/hidden-kinds', headers: person });
    assert.deepEqual(
      hidden.json().hidden.map((row) => [row.catId, row.kind, row.byline]),
      [['codex61-sol', 'video-comments', 'watcher']],
    );
    const restored = await app.inject({
      method: 'POST',
      url: '/api/suggestions/hidden-kinds/restore',
      headers: person,
      payload: { catId: 'codex61-sol', kind: 'video-comments' },
    });
    assert.equal(restored.json().restored, true);
  });
  it('lets a cat bring a work to the desk; the page gets no row for it', async () => {
    const bring = (payload, headers = cat()) =>
      app.inject({ method: 'POST', url: '/api/callbacks/desk-deliveries', headers, payload });
    const queued = await bring({
      sentence: '照他的头像画就行。',
      work: { contentRef: 'work:sheet', ownerRevision: 1 },
    });
    assert.equal(queued.statusCode, 200);
    assert.equal(queued.json().status, 'waiting_for_card');
    assert.deepEqual(broadcasts, []);
    const noCard = await bring({
      messageId: 'msg-282',
      sentence: '照他的头像画就行。',
      work: { contentRef: 'work:sheet', ownerRevision: 1 },
    });
    assert.equal(noCard.statusCode, 400, 'that saved message carries no card for this version');
    const control = await bring({ sentence: '\u202e反过来', work: { contentRef: 'work:sheet', ownerRevision: 1 } });
    assert.equal(control.statusCode, 400);
    const anonymous = await bring(
      { sentence: '照他的头像画就行。', work: { contentRef: 'work:sheet', ownerRevision: 1 } },
      person,
    );
    assert.equal(anonymous.statusCode, 401);
  });
});
