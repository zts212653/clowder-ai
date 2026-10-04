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
  let richBlockKinds;
  let ownedSeedApplications;
  let sourceStates;

  beforeEach(async () => {
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { MemoryCueDrillHandleService } = await import('../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
    const { registerCallbackMemoryCueRoutes } = await import('../dist/routes/callback-memory-cue-routes.js');

    now = 1_000;
    readCalls = [];
    richBlockKinds = new Set();
    ownedSeedApplications = new Set();
    sourceStates = new Map();
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
      const catId = header('x-test-cat', 'codex-sol');
      request.callbackAuth = {
        invocationId,
        callbackToken: 'callback-token',
        catId,
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
          const sourceState = sourceStates.get(input.anchor);
          if (sourceState instanceof Error) throw sourceState;
          if (sourceState) return sourceState;
          if (input.anchor.startsWith('taste-vignette:')) {
            return {
              status: 'ok',
              payload: {
                triggerKey: 'ELI5',
                applicationContract: {
                  v: 1,
                  tool: 'cat_cafe_create_rich_block',
                  requiredRichBlockKind: 'html_widget',
                  plainMarkdownSatisfies: false,
                },
                vignette: { quotes: ['approved Taste'], scene: 'Render an HTML explanation.' },
              },
            };
          }
          if (input.anchor.startsWith('owned-seed:')) {
            const [, , seedId] = input.anchor.split(':');
            return {
              status: 'ok',
              payload: {
                seedId,
                claim: 'private seed body',
                sourceKind: 'originated',
                sourceRunId: 'dreamrun-source',
                sourceRevision: input.expectedRevision,
                authority: 'producing_cat_private_hypothesis',
                allowedUse: 'present_loop_private_intent_or_silence',
              },
            };
          }
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
      applicationEvidence: {
        hasRichBlock({ kind }) {
          return richBlockKinds.has(kind);
        },
        hasOwnedSeedIntent(input) {
          return ownedSeedApplications.has(
            [input.ownerUserId, input.catId, input.invocationId, input.seedId].join('\0'),
          );
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
      catalogVersion: 5,
      resolverFamily: 'person_entity',
      resolverVersion: 1,
      family: 'person_memory',
      anchor: 'person:alden',
      revision: 'revision-1',
      scope: OWNER_SCOPE,
      consumerCatId: 'codex-sol',
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
      ...(input.consumerCatId ? { consumerCatId: input.consumerCatId } : {}),
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
    const { consumerCatId: _consumerCatId, ...unboundInput } = input;
    const unboundHandle = handles.issue(unboundInput);
    assert.equal(handle.includes('secret-anchor'), false);
    assert.equal(
      handle.length,
      unboundHandle.length,
      'consumer binding belongs to the presented receipt, not duplicated prompt-carrier bytes',
    );
    assert.ok(
      handle.length < 200,
      `content-free presented lookup should keep the opaque handle short: ${handle.length}`,
    );
    assert.deepEqual(handles.verify(handle, OWNER_SCOPE, now, 'codex-sol'), { ok: true, coordinate: input });

    const { MemoryCueDrillHandleService } = await import('../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
    const restarted = new MemoryCueDrillHandleService(Buffer.alloc(32, 8), episodeStore);
    assert.deepEqual(restarted.verify(handle, OWNER_SCOPE, now), {
      ok: false,
      reason: 'invalid_handle',
    });
    assert.deepEqual(handles.verify(handle, { ...OWNER_SCOPE, threadId: 'thread-other' }, now, 'codex-sol'), {
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
        consumerCatId: 'codex-sol',
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

  it('does not persist canonical Decision content returned by an evidence drill', async () => {
    const input = coordinate({
      cueId: 'cue-decision-content-free',
      resolverFamily: 'decision',
      family: 'evidence',
      anchor: 'ADR-020',
      revision: 'sha256:decision-revision',
    });
    present(input);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle: handles.issue(input), requestId: 'drill-decision-content-free' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().payload.body, 'canonical owner-visible source');
    const events = episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId);
    assert.deepEqual(
      events.map((event) => event.consumptionOutcome),
      ['presented', 'drilled'],
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
      const event = episodeStore
        .listByCue(OWNER_SCOPE.ownerUserId, input.cueId)
        .find((candidate) => candidate.consumptionOutcome === outcome);
      assert.ok(event);
      assert.deepEqual(response.json(), {
        status: 'recorded',
        outcome,
        outcomeRef: {
          ownerFeatureId: 'F287',
          ownerStateRef: `memory-cue-consumption:${event.eventId}`,
          version: event.createdAt,
        },
      });
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

  it('late-settles an expired handle only from a durable successful drill and current source', async () => {
    const input = coordinate({ cueId: 'cue-late-settlement', expiresAt: 1_500 });
    present(input);
    const handle = handles.issue(input);
    const drill = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle, requestId: 'drill-before-expiry' },
    });
    assert.equal(drill.statusCode, 200);

    now = 1_500;
    const outcome = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: { handle, outcome: 'applied', requestId: 'late-applied' },
    });

    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.json().settlement, 'late_after_drill');
    assert.deepEqual(
      episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).map((event) => ({
        axis: event.axis,
        outcome: event.consumptionOutcome,
        invalidation: event.invalidationReason,
      })),
      [
        { axis: 'consumption', outcome: 'presented', invalidation: null },
        { axis: 'consumption', outcome: 'drilled', invalidation: null },
        { axis: 'consumption', outcome: 'applied', invalidation: null },
      ],
      'carrier expiry must not erase a source that was successfully read and safely settled',
    );
    assert.equal(readCalls.length, 2, 'late settlement revalidates the current source after the original drill');
  });

  it('keeps expired handles closed when no successful drill exists', async () => {
    const input = coordinate({ cueId: 'cue-expired-without-drill', expiresAt: 1_500 });
    present(input);
    const handle = handles.issue(input);
    now = 1_500;

    const outcome = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: { handle, outcome: 'dismissed', requestId: 'late-without-drill' },
    });

    assert.equal(outcome.statusCode, 410);
    assert.deepEqual(outcome.json(), { error: 'expired' });
    assert.equal(episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).at(-1).invalidationReason, 'expired');
  });

  it('keeps an exact committed outcome retry idempotent after the carrier expires', async () => {
    const input = coordinate({ cueId: 'cue-expired-exact-retry', expiresAt: 1_500 });
    present(input);
    const handle = handles.issue(input);
    const payload = { handle, outcome: 'dismissed', requestId: 'expired-exact-retry' };
    const first = await app.inject({ method: 'POST', url: '/api/callbacks/memory-cues/outcome', payload });
    assert.equal(first.statusCode, 200);

    now = 1_500;
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/memory-cues/outcome', payload });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().settlement, undefined);
    assert.equal(episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).length, 2);
  });

  it('late settlement revalidates correction, deletion, and permission revocation without reviving the old cue', async () => {
    for (const [suffix, invalidationReason] of [
      ['corrected', 'source_corrected'],
      ['deleted', 'source_forgotten'],
      ['revoked', 'scope_revoked'],
    ]) {
      now = 1_000;
      const anchor = `person:late-${suffix}`;
      const input = coordinate({ cueId: `cue-late-${suffix}`, anchor, expiresAt: 1_500 });
      present(input);
      const handle = handles.issue(input);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/callbacks/memory-cues/drill',
            payload: { handle, requestId: `drill-late-${suffix}` },
          })
        ).statusCode,
        200,
      );

      sourceStates.set(anchor, { status: 'not_available', invalidationReason });
      now = 1_500;
      const denied = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: { handle, outcome: 'applied', requestId: `late-${suffix}` },
      });
      assert.equal(denied.statusCode, 404);
      assert.deepEqual(denied.json(), { error: 'not_available' });
      assert.equal(
        episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).at(-1).invalidationReason,
        invalidationReason,
      );

      sourceStates.set(anchor, {
        status: 'ok',
        payload: { kind: 'person_memory', anchor, body: 'restored current source' },
      });
      const oldCueRetry = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: { handle, outcome: 'applied', requestId: `late-${suffix}` },
      });
      assert.equal(oldCueRetry.statusCode, 409, 'restoring source access requires a newly presented current cue');
      assert.deepEqual(oldCueRetry.json(), { error: 'cue_invalidated' });
    }
  });

  it('can retry late settlement after a transient source read failure without inventing invalidation', async () => {
    const input = coordinate({ cueId: 'cue-late-transient', anchor: 'person:late-transient', expiresAt: 1_500 });
    present(input);
    const handle = handles.issue(input);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/memory-cues/drill',
          payload: { handle, requestId: 'drill-late-transient' },
        })
      ).statusCode,
      200,
    );

    sourceStates.set(input.anchor, new Error('temporary reader failure'));
    now = 1_500;
    const failed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: { handle, outcome: 'applied', requestId: 'late-transient' },
    });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { error: 'source_read_failed', retryable: true });
    assert.equal(
      episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).some((event) => event.axis === 'invalidation'),
      false,
    );

    sourceStates.set(input.anchor, {
      status: 'ok',
      payload: { kind: 'person_memory', anchor: input.anchor, body: 'recovered source' },
    });
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: { handle, outcome: 'applied', requestId: 'late-transient' },
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().settlement, 'late_after_drill');
  });

  it('keeps a real person reader failure retryable during late settlement', async () => {
    const { MemoryCueDrillHandleService } = await import('../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
    const { MemoryCueEpisodeStore } = await import('../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { PersonMemoryCueSource } = await import('../dist/domains/memory/cue/sources/PersonMemoryCueSource.js');
    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { registerCallbackMemoryCueRoutes } = await import('../dist/routes/callback-memory-cue-routes.js');

    const personCard = {
      personId: 'person-sol',
      displayName: 'Sol',
      facts: [],
      relationshipId: 'relationship-sol',
      uncertainty: [],
      provenanceRefs: [{ kind: 'message', threadId: 'thread-history', messageId: 'message-history' }],
      dossierRef: 'person-sol',
      estimatedTokens: 10,
      storable: false,
      indexable: false,
    };
    const currentMessage = {
      id: 'message-current',
      threadId: OWNER_SCOPE.threadId,
      userId: OWNER_SCOPE.ownerUserId,
      catId: null,
      content: 'Sol is here',
      mentions: [],
      timestamp: 1_000,
    };
    const historyMessage = {
      ...currentMessage,
      id: 'message-history',
      threadId: 'thread-history',
      content: 'Canonical person source',
    };
    let recallMode = 'fresh';
    const personSource = new PersonMemoryCueSource({
      recall: {
        async recallByWorkspaceEntityRef() {
          return { status: 'resolved', card: personCard, asOf: 900 };
        },
        async recallByPersonId() {
          if (recallMode === 'failed') throw new Error('temporary DB unavailable');
          return { status: 'resolved', card: personCard, asOf: 900 };
        },
      },
      messageStore: {
        getById: async (messageId) => (messageId === currentMessage.id ? currentMessage : historyMessage),
      },
    });
    const projection = await personSource.resolve({
      ownerUserId: OWNER_SCOPE.ownerUserId,
      threadId: OWNER_SCOPE.threadId,
      entityId: 'person:sol',
      matchedAlias: 'Sol',
      sourceMessageId: currentMessage.id,
    });
    assert.ok(projection);

    const realDb = new Database(':memory:');
    applyMigrations(realDb);
    const realEpisodeStore = new MemoryCueEpisodeStore(realDb, {
      nowIso: () => '2026-08-01T00:00:00.000Z',
    });
    const realHandles = new MemoryCueDrillHandleService(Buffer.alloc(32, 9), realEpisodeStore);
    let realNow = 1_000;
    const realApp = Fastify({ logger: false });
    realApp.decorateRequest('callbackAuth', undefined);
    realApp.addHook('preHandler', async (request) => {
      request.callbackAuth = {
        invocationId: OWNER_SCOPE.invocationId,
        callbackToken: 'callback-token',
        catId: 'codex-sol',
        threadId: OWNER_SCOPE.threadId,
        userId: OWNER_SCOPE.ownerUserId,
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt: 10_000,
      };
    });
    registerCallbackMemoryCueRoutes(realApp, {
      episodeStore: realEpisodeStore,
      handles: realHandles,
      now: () => realNow,
      sourceReader: {
        read(request) {
          return personSource.read({
            ownerUserId: request.scope.ownerUserId,
            anchor: request.anchor,
            expectedRevision: request.expectedRevision,
          });
        },
      },
    });
    await realApp.ready();

    try {
      const input = coordinate({
        cueId: 'cue-real-person-transient',
        anchor: projection.anchor,
        revision: projection.revision,
        expiresAt: 1_500,
      });
      realEpisodeStore.append({
        eventId: `event-presented-${input.cueId}`,
        idempotencyKey: `presented-${input.cueId}`,
        cueId: input.cueId,
        opportunityId: input.opportunityId,
        scope: input.scope,
        consumerCatId: input.consumerCatId,
        resolverFamily: input.resolverFamily,
        sourceAnchor: input.anchor,
        sourceRevision: input.revision,
        axis: 'consumption',
        consumptionOutcome: 'presented',
        catalogVersion: input.catalogVersion,
        resolverVersion: input.resolverVersion,
        occurredAt: 900,
      });
      const handle = realHandles.issue(input);
      const drill = await realApp.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/drill',
        payload: { handle, requestId: 'drill-real-person' },
      });
      assert.equal(drill.statusCode, 200);

      recallMode = 'failed';
      realNow = 1_500;
      const failed = await realApp.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: { handle, outcome: 'applied', requestId: 'late-real-person' },
      });
      assert.equal(failed.statusCode, 503);
      assert.deepEqual(failed.json(), { error: 'source_read_failed', retryable: true });
      assert.equal(
        realEpisodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).some((event) => event.axis === 'invalidation'),
        false,
      );

      recallMode = 'fresh';
      const recovered = await realApp.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: { handle, outcome: 'applied', requestId: 'late-real-person' },
      });
      assert.equal(recovered.statusCode, 200);
      assert.equal(recovered.json().settlement, 'late_after_drill');
    } finally {
      await realApp.close();
      realDb.close();
    }
  });

  it('records explicit approved Taste as applied only after drill and same-invocation HTML evidence', async () => {
    const input = coordinate({
      cueId: 'cue-eli5',
      resolverFamily: 'taste',
      resolverVersion: 2,
      family: 'taste',
      anchor: 'taste-vignette:docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md',
    });
    present(input);
    const handle = handles.issue(input);
    const outcomePayload = { handle, outcome: 'applied', requestId: 'apply-eli5' };

    const beforeDrill = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(beforeDrill.statusCode, 409);
    assert.deepEqual(beforeDrill.json(), { error: 'application_evidence_required' });

    const drill = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle, requestId: 'drill-eli5' },
    });
    assert.equal(drill.statusCode, 200);
    assert.equal(drill.json().payload.applicationContract.requiredRichBlockKind, 'html_widget');

    const markdownOnly = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(markdownOnly.statusCode, 409);
    assert.deepEqual(markdownOnly.json(), { error: 'application_evidence_required' });

    richBlockKinds.add('html_widget');
    const applied = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(applied.statusCode, 200);
    const appliedEvent = episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).at(-1);
    assert.deepEqual(applied.json(), {
      status: 'recorded',
      outcome: 'applied',
      outcomeRef: {
        ownerFeatureId: 'F287',
        ownerStateRef: `memory-cue-consumption:${appliedEvent.eventId}`,
        version: appliedEvent.createdAt,
      },
    });
    assert.deepEqual(
      episodeStore
        .listByCue(OWNER_SCOPE.ownerUserId, input.cueId)
        .map((event) => event.consumptionOutcome)
        .filter(Boolean),
      ['presented', 'drilled', 'applied'],
    );

    richBlockKinds.clear();
    const exactRetry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(exactRetry.statusCode, 200, 'an exact committed retry must not depend on transient buffer state');

    const newRequestWithoutEvidence = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: { ...outcomePayload, requestId: 'apply-eli5-new' },
    });
    assert.equal(newRequestWithoutEvidence.statusCode, 409);
  });

  it('records a cat-owned Seed as applied only after same-invocation drill and exact cat intent evidence', async () => {
    const input = coordinate({
      cueId: 'cue-owned-seed',
      resolverFamily: 'cat_owned_seed',
      family: 'owned_seed',
      anchor: 'owned-seed:codex-sol:seed_1',
      revision: 'sha256:seed-revision-1',
      consumerCatId: 'codex-sol',
    });
    present(input);
    const handle = handles.issue(input);
    const outcomePayload = { handle, outcome: 'applied', requestId: 'apply-owned-seed' };

    const beforeDrill = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(beforeDrill.statusCode, 409);
    assert.deepEqual(beforeDrill.json(), { error: 'application_evidence_required' });

    const drill = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      payload: { handle, requestId: 'drill-owned-seed' },
    });
    assert.equal(drill.statusCode, 200);
    assert.equal(drill.json().payload.claim, 'private seed body');

    const withoutIntent = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(withoutIntent.statusCode, 409);
    assert.deepEqual(withoutIntent.json(), { error: 'application_evidence_required' });

    ownedSeedApplications.add([OWNER_SCOPE.ownerUserId, 'codex-sol', OWNER_SCOPE.invocationId, 'seed_1'].join('\0'));
    const applied = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/outcome',
      payload: outcomePayload,
    });
    assert.equal(applied.statusCode, 200);
    const appliedEvent = episodeStore.listByCue(OWNER_SCOPE.ownerUserId, input.cueId).at(-1);
    assert.deepEqual(applied.json(), {
      status: 'recorded',
      outcome: 'applied',
      outcomeRef: {
        ownerFeatureId: 'F287',
        ownerStateRef: `memory-cue-consumption:${appliedEvent.eventId}`,
        version: appliedEvent.createdAt,
      },
    });
    assert.equal(appliedEvent.consumerCatId, 'codex-sol');

    const crossCat = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-cues/drill',
      headers: { 'x-test-cat': 'codex-terra' },
      payload: { handle, requestId: 'cross-cat-drill' },
    });
    assert.equal(crossCat.statusCode, 404);
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
      consumerCatId: invalidated.consumerCatId,
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
      consumerCatId: input.consumerCatId,
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
