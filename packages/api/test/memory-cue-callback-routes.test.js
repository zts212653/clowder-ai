import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const OWNER_SCOPE = {
  ownerUserId: 'owner-1',
  threadId: 'thread-1',
  invocationId: 'invocation-1',
};

describe('F287 owner-authenticated memory cue callbacks', () => {
  let app;
  let db;
  let episodeStore;
  let handles;
  let now;
  let readCalls;

  beforeEach(async () => {
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { MemoryCueDrillHandleService } = await import('../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
    const { registerCallbackMemoryCueRoutes } = await import('../dist/routes/callback-memory-cue-routes.js');

    now = 1_000;
    readCalls = [];
    db = new Database(':memory:');
    applyMigrations(db);
    episodeStore = new MemoryCueEpisodeStore(db, {
      nowIso: () => '2026-08-01T00:00:00.000Z',
    });
    handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), episodeStore);

    app = Fastify({ logger: false });
    app.decorateRequest('callbackAuth', undefined);
    app.addHook('preHandler', async (request) => {
      const header = (name, fallback) => (typeof request.headers[name] === 'string' ? request.headers[name] : fallback);
      const ownerUserId = header('x-test-owner', OWNER_SCOPE.ownerUserId);
      const threadId = header('x-test-thread', OWNER_SCOPE.threadId);
      const invocationId = header('x-test-invocation', OWNER_SCOPE.invocationId);
      request.callbackAuth = {
        invocationId,
        callbackToken: 'callback-token',
        catId: 'codex-sol',
        threadId,
        userId: ownerUserId,
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt: 10_000,
      };
    });
    registerCallbackMemoryCueRoutes(app, {
      episodeStore,
      handles,
      now: () => now,
      sourceReader: {
        async read(input) {
          readCalls.push(input);
          const invalidationReason = {
            'person:corrected': 'source_corrected',
            'person:forgotten': 'source_forgotten',
            'person:deleted': 'source_forgotten',
            'person:superseded': 'superseded',
            'person:private': 'scope_revoked',
          }[input.anchor];
          if (invalidationReason) return { status: 'not_available', invalidationReason };
          return {
            status: 'ok',
            payload: { kind: input.family, anchor: input.anchor, body: 'canonical owner-visible source' },
          };
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function coordinate(overrides = {}) {
    return {
      cueId: 'cue-1',
      opportunityId: 'opportunity-1',
      catalogVersion: 1,
      resolverFamily: 'person_entity',
      resolverVersion: 1,
      family: 'person_memory',
      anchor: 'person:alden',
      revision: 'revision-1',
      scope: OWNER_SCOPE,
      expiresAt: 5_000,
      ...overrides,
    };
  }

  function present(input = coordinate()) {
    episodeStore.append({
      eventId: `event-presented-${input.cueId}`,
      idempotencyKey: `presented-${input.cueId}`,
      cueId: input.cueId,
      opportunityId: input.opportunityId,
      scope: input.scope,
      resolverFamily: input.resolverFamily,
      sourceAnchor: input.anchor,
      sourceRevision: input.revision,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: input.catalogVersion,
      resolverVersion: input.resolverVersion,
      occurredAt: 900,
    });
  }

  it('keeps handles opaque, process-scoped and bound to exact owner/thread/invocation scope', async () => {
    const input = coordinate({ anchor: 'person:secret-anchor' });
    present(input);
    const handle = handles.issue(input);
    assert.equal(handle.includes('secret-anchor'), false);
    assert.ok(
      handle.length < 200,
      `content-free presented lookup should keep the opaque handle short: ${handle.length}`,
    );
    assert.deepEqual(handles.verify(handle, OWNER_SCOPE, now), { ok: true, coordinate: input });

    const { MemoryCueDrillHandleService } = await import('../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
    const restarted = new MemoryCueDrillHandleService(Buffer.alloc(32, 8), episodeStore);
    assert.deepEqual(restarted.verify(handle, OWNER_SCOPE, now), {
      ok: false,
      reason: 'invalid_handle',
    });
    assert.deepEqual(handles.verify(handle, { ...OWNER_SCOPE, threadId: 'thread-other' }, now), {
      ok: false,
      reason: 'scope_mismatch',
    });
  });

  it('drills only a currently valid canonical revision and appends a content-free outcome', async () => {
    const input = coordinate();
    present(input);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle: handles.issue(input), requestId: 'drill-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'ok',
      payload: { kind: 'person_memory', anchor: 'person:alden', body: 'canonical owner-visible source' },
    });
    assert.deepEqual(readCalls, [
      {
        family: 'person_memory',
        anchor: 'person:alden',
        expectedRevision: 'revision-1',
        scope: OWNER_SCOPE,
      },
    ]);
    const events = episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId);
    assert.deepEqual(
      events.map(({ axis, consumptionOutcome, invalidationReason }) => ({
        axis,
        consumptionOutcome,
        invalidationReason,
      })),
      [
        { axis: 'consumption', consumptionOutcome: 'presented', invalidationReason: null },
        { axis: 'consumption', consumptionOutcome: 'drilled', invalidationReason: null },
      ],
    );
    assert.equal(JSON.stringify(events).includes('canonical owner-visible source'), false);
  });

  it('records applied/dismissed without accepting outcome rationale or caller-owned coordinates', async () => {
    for (const outcome of ['applied', 'dismissed']) {
      const input = coordinate({ cueId: `cue-${outcome}` });
      present(input);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: { handle: handles.issue(input), outcome, requestId: `outcome-${outcome}` },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: 'recorded', outcome });
    }

    const poisoned = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: {
        handle: handles.issue(coordinate()),
        outcome: 'applied',
        requestId: 'poisoned',
        ownerUserId: 'victim',
        sourceBody: 'private',
        rationale: 'model reasoning',
        anchor: 'raw:coordinate',
      },
    });
    assert.equal(poisoned.statusCode, 400);
  });

  it('rejects never-presented and already-invalidated outcome telemetry', async () => {
    const neverPresented = coordinate({ cueId: 'cue-never-presented' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: {
        handle: handles.issue(neverPresented),
        outcome: 'applied',
        requestId: 'never-presented',
      },
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: 'presentation_required' });

    const invalidated = coordinate({ cueId: 'cue-invalidated' });
    present(invalidated);
    episodeStore.append({
      eventId: 'event-invalidated',
      idempotencyKey: 'invalidated-1',
      cueId: invalidated.cueId,
      opportunityId: invalidated.opportunityId,
      scope: invalidated.scope,
      resolverFamily: invalidated.resolverFamily,
      sourceAnchor: invalidated.anchor,
      sourceRevision: invalidated.revision,
      axis: 'invalidation',
      invalidationReason: 'source_forgotten',
      catalogVersion: invalidated.catalogVersion,
      resolverVersion: invalidated.resolverVersion,
      occurredAt: 950,
    });
    const late = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: {
        handle: handles.issue(invalidated),
        outcome: 'dismissed',
        requestId: 'late-outcome',
      },
    });
    assert.equal(late.statusCode, 409);
    assert.deepEqual(late.json(), { error: 'cue_invalidated' });
  });

  it('keeps an exact pre-invalidation outcome retry idempotent without reviving the cue', async () => {
    const input = coordinate({ cueId: 'cue-outcome-retry' });
    present(input);
    const payload = {
      handle: handles.issue(input),
      outcome: 'applied',
      requestId: 'stable-outcome-retry',
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/memory-cues/outcome',
          payload,
        })
      ).statusCode,
      200,
    );
    episodeStore.append({
      eventId: 'event-outcome-retry-invalidated',
      idempotencyKey: 'outcome-retry-invalidated',
      cueId: input.cueId,
      opportunityId: input.opportunityId,
      scope: input.scope,
      resolverFamily: input.resolverFamily,
      sourceAnchor: input.anchor,
      sourceRevision: input.revision,
      axis: 'invalidation',
      invalidationReason: 'source_corrected',
      catalogVersion: input.catalogVersion,
      resolverVersion: input.resolverVersion,
      occurredAt: 975,
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload,
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).length, 3);
  });

  it('turns corrected/forgotten/deleted/superseded/private sources into zero payload plus invalidation', async () => {
    for (const [suffix, expectedReason] of [
      ['corrected', 'source_corrected'],
      ['forgotten', 'source_forgotten'],
      ['deleted', 'source_forgotten'],
      ['superseded', 'superseded'],
      ['private', 'scope_revoked'],
    ]) {
      const input = coordinate({ cueId: `cue-${suffix}`, anchor: `person:${suffix}` });
      present(input);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/drill',
        payload: { handle: handles.issue(input), requestId: `drill-${suffix}` },
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: 'not_available' });
      const events = episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId);
      assert.equal(events.at(-1).axis, 'invalidation');
      assert.equal(events.at(-1).invalidationReason, expectedReason);
    }
  });

  it('records signed expiry but leaves cross-scope replay and tampering content-free and silent', async () => {
    const expired = coordinate({ cueId: 'cue-expired', expiresAt: 1_500 });
    present(expired);
    now = 1_500;
    const expiredResponse = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle: handles.issue(expired), requestId: 'expired-drill' },
    });
    assert.equal(expiredResponse.statusCode, 410);
    assert.deepEqual(expiredResponse.json(), { error: 'expired' });
    assert.equal(episodeStore.listByCue(OWNER_SCOPE.ownerUserId, expired.cueId).at(-1).invalidationReason, 'expired');

    now = 1_000;
    const valid = coordinate({ cueId: 'cue-replay' });
    present(valid);
    const handle = handles.issue(valid);
    const crossScope = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      headers: { 'x-test-thread': 'thread-attacker' },
      payload: { handle, requestId: 'cross-scope' },
    });
    assert.equal(crossScope.statusCode, 404);
    const [prefix, ivPart, ciphertextPart, tagPart] = handle.split('.');
    const decodedTag = Buffer.from(tagPart, 'base64url');
    const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const nonCanonicalLastChar = [...base64urlAlphabet].find((candidate) => {
      if (candidate === tagPart.at(-1)) return false;
      const alias = `${tagPart.slice(0, -1)}${candidate}`;
      return Buffer.from(alias, 'base64url').equals(decodedTag);
    });
    assert.ok(nonCanonicalLastChar, '16-byte tags must have a non-canonical base64url alias');
    const nonCanonicalHandle = [prefix, ivPart, ciphertextPart, `${tagPart.slice(0, -1)}${nonCanonicalLastChar}`].join(
      '.',
    );
    const tampered = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle: nonCanonicalHandle, requestId: 'tampered' },
    });
    assert.equal(tampered.statusCode, 404);
    assert.equal(episodeStore.listByCue(OWNER_SCOPE.ownerUserId, valid.cueId).length, 1);
  });
});
