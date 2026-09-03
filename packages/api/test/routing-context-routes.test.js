import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const OWNER_ID = 'routing-owner';

function freshSnapshot(ownerId, observedAt) {
  return {
    v: 1,
    ownerId,
    observedAt,
    catalogRevision: 'catalog:test',
    candidates: [],
  };
}

function fakeRuntime() {
  const signalEvents = [];
  const preferences = [];
  let sequence = 0;
  let currentNow = 1_000;
  const nextId = (prefix) => `${prefix}-${++sequence}`;
  return {
    signalEvents,
    preferences,
    now: () => currentNow,
    setNow(value) {
      currentNow = value;
    },
    nextId,
    readService: {
      async read({ ownerId, observedAt }) {
        return {
          v: 1,
          ownerId,
          observedAt,
          catalogRevision: 'catalog:test',
          resolution: {
            state: 'fresh',
            snapshot: freshSnapshot(ownerId, observedAt),
            inputRevisionRef: 'sha256:test',
            sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
          },
          signalEvents: [...signalEvents],
          preferenceRevisions: [...preferences],
        };
      },
    },
    signalStore: {
      async append(event) {
        if (signalEvents.some((candidate) => candidate.commandId === event.commandId)) {
          const replay = signalEvents.find((candidate) => candidate.commandId === event.commandId);
          if (JSON.stringify(replay) !== JSON.stringify(event)) throw new Error('routing signal command conflict');
          return { outcome: 'replayed', event: replay };
        }
        if (event.eventType !== 'asserted') {
          for (const signalId of event.closesSignalIds) {
            const assertion = signalEvents.find((candidate) => candidate.eventId === signalId);
            const closed = signalEvents.some(
              (candidate) => candidate.eventType !== 'asserted' && candidate.closesSignalIds.includes(signalId),
            );
            if (!assertion || assertion.eventType !== 'asserted' || closed) {
              const error = new Error('routing signal closure conflict');
              error.name = 'RoutingSignalEventConflictError';
              throw error;
            }
          }
        }
        signalEvents.push(event);
        return { outcome: 'appended', event };
      },
      async get(ownerId, eventId) {
        return signalEvents.find((event) => event.ownerId === ownerId && event.eventId === eventId) ?? null;
      },
      async getByCommand(ownerId, commandId) {
        return signalEvents.find((event) => event.ownerId === ownerId && event.commandId === commandId) ?? null;
      },
    },
    preferenceStore: {
      async append(revision) {
        preferences.push(revision);
        return { outcome: 'appended', revision };
      },
      async getHead(ownerId, preferenceId) {
        return (
          preferences
            .filter((revision) => revision.ownerId === ownerId && revision.preferenceId === preferenceId)
            .sort((left, right) => right.version - left.version)[0] ?? null
        );
      },
      async getByCommand(ownerId, commandId) {
        return preferences.find((revision) => revision.ownerId === ownerId && revision.commandId === commandId) ?? null;
      },
    },
  };
}

async function buildApp(runtime) {
  const { routingContextRoutes } = await import('../dist/routes/routing-context.js');
  const app = Fastify();
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  await app.register(routingContextRoutes, { runtime });
  return app;
}

describe('F293 routing context owner routes', () => {
  let previousOwner;
  let app;

  beforeEach(() => {
    previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });

  test('returns 503 instead of installing an in-memory fallback when durable runtime is absent', async () => {
    app = await buildApp(undefined);
    const response = await app.inject({
      method: 'GET',
      url: '/api/routing-context/snapshot',
      headers: { 'x-test-session-user': OWNER_ID },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'Routing context persistence is unavailable');
  });

  test('requires strict session identity and configured owner for reads and writes', async () => {
    app = await buildApp(fakeRuntime());
    const noSession = await app.inject({ method: 'GET', url: '/api/routing-context/snapshot' });
    assert.equal(noSession.statusCode, 401);
    const nonOwner = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': 'intruder' },
      payload: {
        v: 1,
        commandId: 'mark-1',
        subjectRef: { type: 'cat', catId: 'fable5' },
        state: 'scarce',
        reasonCode: 'quota_low',
        validUntil: 2_000,
      },
    });
    assert.equal(nonOwner.statusCode, 403);
  });

  test('derives owner/source/event identity and returns the shared read model', async () => {
    const runtime = fakeRuntime();
    app = await buildApp(runtime);
    const create = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'mark-1',
        subjectRef: { type: 'provider', providerId: 'anthropic' },
        state: 'unavailable',
        reasonCode: 'provider_down',
        note: 'Provider health check failed',
        validUntil: 2_000,
      },
    });
    assert.equal(create.statusCode, 201);
    assert.deepEqual(create.json().event, {
      v: 1,
      eventId: 'signal-1',
      commandId: 'mark-1',
      ownerId: OWNER_ID,
      subjectRef: { type: 'provider', providerId: 'anthropic' },
      reasonCode: 'provider_down',
      note: 'Provider health check failed',
      source: 'manual_cvo',
      observedAt: 1_000,
      evidenceRef: 'routing-context:manual:mark-1',
      eventType: 'asserted',
      state: 'unavailable',
      validUntil: 2_000,
    });

    const read = await app.inject({
      method: 'GET',
      url: '/api/routing-context/snapshot',
      headers: { 'x-test-session-user': OWNER_ID },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().ownerId, OWNER_ID);
    assert.equal(read.json().signalEvents[0].eventId, 'signal-1');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'mark-1',
        subjectRef: { type: 'provider', providerId: 'anthropic' },
        state: 'unavailable',
        reasonCode: 'provider_down',
        note: 'Provider health check failed',
        validUntil: 2_000,
      },
    });
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().outcome, 'replayed');
    assert.equal(runtime.signalEvents.length, 1);

    const collision = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'mark-1',
        subjectRef: { type: 'provider', providerId: 'anthropic' },
        state: 'degraded',
        reasonCode: 'provider_down',
        validUntil: 2_000,
      },
    });
    assert.equal(collision.statusCode, 409);
  });

  test('rejects client-owned identity fields and a non-future validity boundary', async () => {
    app = await buildApp(fakeRuntime());
    const injected = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'mark-1',
        ownerId: 'intruder',
        eventId: 'chosen',
        source: 'provider_error',
        subjectRef: { type: 'cat', catId: 'fable5' },
        state: 'scarce',
        reasonCode: 'quota_low',
        validUntil: 2_000,
      },
    });
    assert.equal(injected.statusCode, 400);
    const expired = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'mark-2',
        subjectRef: { type: 'cat', catId: 'fable5' },
        state: 'scarce',
        reasonCode: 'quota_low',
        validUntil: 999,
      },
    });
    assert.equal(expired.statusCode, 400);
  });

  test('recovers or retracts the exact stored assertion subject and rejects a second closer', async () => {
    const runtime = fakeRuntime();
    app = await buildApp(runtime);
    await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'mark-1',
        subjectRef: { type: 'cat', catId: 'fable5' },
        state: 'scarce',
        reasonCode: 'quota_low',
        validUntil: 2_000,
      },
    });
    runtime.setNow(3_000);
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals/signal-1/recover',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: { v: 1, commandId: 'recover-1', reasonCode: 'manual_confirmed' },
    });
    assert.equal(recovered.statusCode, 201);
    assert.deepEqual(recovered.json().event.subjectRef, { type: 'cat', catId: 'fable5' });
    assert.deepEqual(recovered.json().event.closesSignalIds, ['signal-1']);
    const second = await app.inject({
      method: 'POST',
      url: '/api/routing-context/signals/signal-1/retract',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: { v: 1, commandId: 'retract-1', reasonCode: 'mistake' },
    });
    assert.equal(second.statusCode, 409);
  });

  test('creates, supersedes and terminally retires an exact preference chain', async () => {
    const runtime = fakeRuntime();
    app = await buildApp(runtime);
    const rule = {
      v: 1,
      commandId: 'pref-create',
      appliesWhen: { intent: 'review' },
      prefer: [{ type: 'cat', catId: 'codex-terra' }],
      over: [{ type: 'cat', catId: 'gpt52' }],
      rationale: 'Prefer Terra for current review work.',
      evidenceRefs: ['message:policy'],
      reviewAfter: 2_000,
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/routing-context/preferences',
      headers: { 'x-test-session-user': OWNER_ID },
      payload: rule,
    });
    assert.equal(created.statusCode, 201);
    const first = created.json().revision;
    assert.equal(first.preferenceId, 'preference-1');
    assert.equal(first.revisionId, 'preference-revision-2');
    assert.equal(first.version, 1);

    const updated = await app.inject({
      method: 'POST',
      url: `/api/routing-context/preferences/${first.preferenceId}/supersede`,
      headers: { 'x-test-session-user': OWNER_ID },
      payload: { ...rule, commandId: 'pref-update', baseRevisionId: first.revisionId, baseVersion: 1 },
    });
    assert.equal(updated.statusCode, 201);
    assert.equal(updated.json().revision.version, 2);
    assert.equal(updated.json().revision.supersedesRevisionId, first.revisionId);

    const renewed = await app.inject({
      method: 'POST',
      url: `/api/routing-context/preferences/${first.preferenceId}/renew`,
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        ...rule,
        commandId: 'pref-renew',
        baseRevisionId: updated.json().revision.revisionId,
        baseVersion: 2,
      },
    });
    assert.equal(renewed.statusCode, 201);
    assert.equal(renewed.json().revision.version, 3);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/routing-context/preferences/${first.preferenceId}/supersede`,
      headers: { 'x-test-session-user': OWNER_ID },
      payload: { ...rule, commandId: 'pref-stale', baseRevisionId: first.revisionId, baseVersion: 1 },
    });
    assert.equal(stale.statusCode, 409);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/routing-context/preferences',
      headers: { 'x-test-session-user': OWNER_ID },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().preferenceRevisions.length, 3);

    const retired = await app.inject({
      method: 'POST',
      url: `/api/routing-context/preferences/${first.preferenceId}/retire`,
      headers: { 'x-test-session-user': OWNER_ID },
      payload: {
        v: 1,
        commandId: 'pref-retire',
        baseRevisionId: renewed.json().revision.revisionId,
        baseVersion: 3,
        retirementReason: 'Policy no longer applies.',
      },
    });
    assert.equal(retired.statusCode, 201);
    assert.equal(retired.json().revision.lifecycle, 'retired');
    assert.equal(retired.json().revision.version, 4);
  });
});
