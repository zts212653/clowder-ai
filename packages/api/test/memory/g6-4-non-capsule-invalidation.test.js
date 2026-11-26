/**
 * G6-4 (F321 AC-A3 / F332 AC-C5): Non-Capsule owner action -> store/document-index
 * invalidation -> cue-source integration regression (Event + private canonical Taste).
 *
 * Scope covered here:
 * 1. Event lane: real Fastify POST /api/memory/events/:id/actions -> EventMemoryStore ->
 *    EventMemoryCueSource (prepareOpportunity / resolve / read).
 * 2. Private Taste lane: real Fastify POST /api/memory/taste/:id/actions ->
 *    TasteMemoryLifecycleService + document-index deleteByAnchor callback ->
 *    CanonicalTasteMemoryCueSource (resolve / read), with independent non-empty
 *    derived-index preconditions for correct, retire, and direct hard_forget.
 *
 * Explicitly outside this test's scope (tracked separately):
 * - Production index.ts composition-root wiring for publishedDocuments.markPending(),
 *   vectorStore.delete(), and public Taste publishedSnapshot;
 * - Full invocation cue-resolver/episode/prompt delivery pipeline & browser E2E;
 * - Person lane Redis owner forget (person-memory-proposal-forget-owner.test.js) and
 *   upstream-gated cat-side Person correction PR2 (U6-2).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { SessionMutex } from '../../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { EventMemoryCueSource } from '../../dist/domains/memory/cue/sources/EventMemoryCueSource.js';
import { CanonicalTasteMemoryCueSource } from '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { EventMemoryStore } from '../../dist/domains/memory/EventMemoryStore.js';
import { EventMemoryLifecycleService } from '../../dist/domains/memory/event/EventMemoryLifecycleService.js';
import { InMemoryEventMemoryCorrectionProposalStore } from '../../dist/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { TasteMemoryLifecycleService } from '../../dist/domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from '../../dist/domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from '../../dist/domains/memory/taste/TasteMemoryProjectionWriter.js';
import { tasteDocumentAnchor } from '../../dist/domains/memory/taste/taste-memory-identity.js';
import { InMemoryTasteProposalStore } from '../../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { sessionAuthPlugin, sessionRoute } from '../../dist/infrastructure/session-auth.js';
import { eventsRoutes } from '../../dist/routes/events.js';
import { tasteBrowseRoutes } from '../../dist/routes/taste-browse.js';

const origin = 'http://localhost:3003';

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

describe('G6-4 non-Capsule cross-layer invalidation (Event + Taste)', () => {
  describe('Event lane: HTTP owner action -> EventMemoryStore -> next-turn EventMemoryCueSource', () => {
    const ownerUserId = 'g64-event-owner';
    const threadId = 'thread-g64-event';
    const messageId = 'msg-g64-event';
    let app;
    let store;
    let cueSource;
    let session;
    let nowMs;

    beforeEach(async () => {
      nowMs = 1_700_000_000_000;
      store = new EventMemoryStore(':memory:');
      await store.initialize();
      const coordinator = new OwnerMemoryActionCoordinator({
        store: new InMemoryOwnerMemoryActionReceiptStore(),
        lock: new SessionMutex(),
      });
      const lifecycle = new EventMemoryLifecycleService({
        store,
        coordinator,
        sourceAvailable: async () => true,
        now: () => nowMs,
      });
      const messageStore = {
        getById: async (id) =>
          id === messageId
            ? {
                id,
                threadId,
                userId: ownerUserId,
                catId: null,
                content: 'Original human brake message.',
                timestamp: nowMs - 1_000,
                deliveryStatus: 'delivered',
              }
            : null,
      };
      cueSource = new EventMemoryCueSource({
        ownerUserId,
        eventStore: store,
        messageStore,
        episodeStore: { hasTerminalConsumptionForSource: () => false },
        now: () => nowMs,
      });
      app = Fastify();
      await app.register(cookie);
      await app.register(sessionAuthPlugin);
      await app.register(sessionRoute, { ownerUserId });
      await app.register(eventsRoutes, {
        eventMemoryStore: store,
        lifecycleService: lifecycle,
        correctionProposalStore: new InMemoryEventMemoryCorrectionProposalStore(),
        threadStore: {
          get: async (id) => (id === threadId ? { id, title: 'Event thread', createdBy: ownerUserId } : null),
          list: async () => [],
        },
        messageStore,
      });
      await app.ready();
      const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
      session = { cookie: cookieHeader(login), csrf: login.json().csrfToken };
    });

    afterEach(async () => {
      await app.close();
    });

    const postAction = (eventId, payload) =>
      app.inject({
        method: 'POST',
        url: `/api/memory/events/${eventId}/actions`,
        headers: {
          cookie: session.cookie,
          origin,
          'x-csrf-token': session.csrf,
          'content-type': 'application/json',
        },
        payload,
      });

    it('invalidates stale cue on correct, delivers corrected summary on next turn, and blocks cues after retire/hard_forget', async () => {
      const created = store.markEvent(
        {
          type: 'scope_correction',
          trigger: 'human_brake',
          cat: 'neo',
          threadId,
          messageId,
          timestamp: nowMs - 500,
          summary: 'Original scope rule before correction.',
          cognitiveTransition: 'scope_correction',
          relatedHarness: ['F321'],
          confidence: 'high',
        },
        ownerUserId,
      );
      const eventId = created.event.eventId;

      // Turn 1: cue opportunity -> resolve -> read returns original summary
      const opp1 = await cueSource.prepareOpportunity({ ownerUserId, threadId, occurredAt: nowMs });
      assert.ok(opp1, 'Turn 1 must emit active event cue opportunity');
      const proj1 = await cueSource.resolve({ ownerUserId, threadId, ...opp1.payload });
      assert.ok(proj1);
      const read1 = await cueSource.read({
        ownerUserId,
        threadId,
        anchor: proj1.anchor,
        expectedRevision: proj1.revision,
      });
      assert.equal(read1.status, 'ok');
      assert.equal(read1.payload.summary, 'Original scope rule before correction.');

      // Owner corrects event through HTTP browse action
      const corrected = await postAction(eventId, {
        action: 'correct',
        requestId: 'g64-event-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: proj1.revision,
        patch: { summary: 'Corrected scope rule v2 for next turn.' },
      });
      assert.equal(corrected.statusCode, 200, corrected.body);
      const rev2 = corrected.json().revision;
      assert.notEqual(rev2, proj1.revision);

      // Stale Turn 1 revision must fail resolve & read immediately
      assert.equal(await cueSource.resolve({ ownerUserId, threadId, ...opp1.payload }), null);
      assert.deepEqual(
        await cueSource.read({ ownerUserId, threadId, anchor: proj1.anchor, expectedRevision: proj1.revision }),
        { status: 'not_available', invalidationReason: 'source_corrected' },
      );

      // Turn 2: next-turn opportunity delivers the corrected summary
      const opp2 = await cueSource.prepareOpportunity({ ownerUserId, threadId, occurredAt: nowMs + 100 });
      assert.ok(opp2);
      assert.equal(opp2.payload.sourceRevision, rev2);
      const proj2 = await cueSource.resolve({ ownerUserId, threadId, ...opp2.payload });
      assert.ok(proj2);
      const read2 = await cueSource.read({
        ownerUserId,
        threadId,
        anchor: proj2.anchor,
        expectedRevision: proj2.revision,
      });
      assert.equal(read2.status, 'ok');
      assert.equal(read2.payload.summary, 'Corrected scope rule v2 for next turn.');

      // Owner retires event -> no next-turn cue and stale read rejected
      const retired = await postAction(eventId, {
        action: 'retire',
        requestId: 'g64-event-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: rev2,
      });
      assert.equal(retired.statusCode, 200, retired.body);
      assert.equal(await cueSource.prepareOpportunity({ ownerUserId, threadId, occurredAt: nowMs + 200 }), null);
      assert.deepEqual(await cueSource.read({ ownerUserId, threadId, anchor: proj2.anchor, expectedRevision: rev2 }), {
        status: 'not_available',
        invalidationReason: 'source_corrected',
      });

      // Owner hard-forgets event -> store empty, next-turn cue null, read reports source_forgotten
      const forgotten = await postAction(eventId, {
        action: 'hard_forget',
        requestId: 'g64-event-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: retired.json().revision,
        confirmed: true,
      });
      assert.equal(forgotten.statusCode, 200, forgotten.body);
      assert.equal(store.getEvent(eventId), null);
      assert.deepEqual(store.listEvents({ ownerUserId, threadId }), []);
      assert.equal(await cueSource.prepareOpportunity({ ownerUserId, threadId, occurredAt: nowMs + 300 }), null);
      assert.deepEqual(await cueSource.read({ ownerUserId, threadId, anchor: proj2.anchor, expectedRevision: rev2 }), {
        status: 'not_available',
        invalidationReason: 'source_forgotten',
      });
    });
  });

  describe('Taste lane: HTTP owner action -> derived index invalidation -> next-turn CanonicalTasteMemoryCueSource', () => {
    const ownerUserId = 'g64-taste-owner';
    const sourcePath = 'private/taste/g64-lifecycle.md';
    const derivedAnchor = tasteDocumentAnchor(sourcePath);
    let app;
    let db;
    let root;
    let lifecycleStore;
    let evidenceStore;
    let cueSource;
    let session;

    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), 'g64-taste-'));
      mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
      mkdirSync(join(root, 'private/taste'), { recursive: true });
      writeFileSync(join(root, 'docs/taste/index.md'), '# Taste Index\n', 'utf8');
      const initialRaw = [
        '---',
        'when: 2026-11-26',
        'quotes: ["truth_first_quote_v1"]',
        'scene: "g64_original_taste_scene"',
        'tags: ["truth", "owner"]',
        'dimension: cognitive-honesty',
        'privacy: sensitive',
        'catId: neo',
        'proposalId: proposal-g64',
        '---',
        '',
      ].join('\n');
      writeFileSync(join(root, sourcePath), initialRaw, 'utf8');
      db = new Database(':memory:');
      applyMigrations(db);
      lifecycleStore = new TasteMemoryLifecycleStore(db);
      evidenceStore = new SqliteEvidenceStore(':memory:');
      await evidenceStore.initialize();
      await evidenceStore.upsert([
        {
          anchor: derivedAnchor,
          kind: 'research',
          status: 'active',
          title: 'Taste vignette projection',
          summary: initialRaw,
          sourcePath,
          updatedAt: new Date().toISOString(),
        },
      ]);

      const repository = {
        canonicalRoot: () => root,
        gitCheckoutRoot: () => root,
        approvalLockKey: () => 'g64-taste-lock',
      };
      const lifecycle = new TasteMemoryLifecycleService({
        store: lifecycleStore,
        writer: new TasteMemoryProjectionWriter(repository),
        coordinator: new OwnerMemoryActionCoordinator({
          store: new InMemoryOwnerMemoryActionReceiptStore(),
          lock: new SessionMutex(),
        }),
        targetLock: new SessionMutex(),
        lockKey: () => 'g64-taste-lock',
        // Exercises the document-index deleteByAnchor portion of Taste derived invalidation.
        invalidateDerived: async ({ sourcePath: invalidatedPath }) => {
          await evidenceStore.deleteByAnchor(tasteDocumentAnchor(invalidatedPath));
        },
      });
      cueSource = new CanonicalTasteMemoryCueSource(repository, ownerUserId, lifecycleStore);

      app = Fastify();
      await app.register(cookie);
      await app.register(sessionAuthPlugin);
      await app.register(sessionRoute, { ownerUserId });
      await app.register(tasteBrowseRoutes, {
        ownerUserId,
        tasteRepository: repository,
        lifecycleStore,
        lifecycleService: lifecycle,
        readObservatory: async () => ({ entries: [], constellations: [], coverage: { totalUnverified: 0 } }),
        proposalStore: new InMemoryTasteProposalStore(),
        threadStore: { get: async () => null, list: async () => [] },
        messageStore: { getById: async () => null },
      });
      await app.ready();
      const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
      session = { cookie: cookieHeader(login), csrf: login.json().csrfToken };
    });

    afterEach(async () => {
      await app.close();
      evidenceStore.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });

    const postAction = (memoryId, payload) =>
      app.inject({
        method: 'POST',
        url: `/api/memory/taste/${memoryId}/actions`,
        headers: {
          cookie: session.cookie,
          origin,
          'x-csrf-token': session.csrf,
          'content-type': 'application/json',
        },
        payload,
      });

    async function loadInitialEntryAndCue() {
      const list = await app.inject({
        method: 'GET',
        url: '/api/memory/taste',
        headers: { cookie: session.cookie },
      });
      assert.equal(list.statusCode, 200, list.body);
      const initial = list.json().entries[0];

      const snap = await cueSource.resolve({
        ownerUserId,
        stage: 'review',
        selectedSkill: 'request-review',
        featureId: 'F321',
      });
      assert.ok(snap);
      const anchor = `taste-dimensions:${snap.dimensions.join(',')}`;
      const read = await cueSource.read({ ownerUserId, anchor, expectedRevision: snap.revision });
      assert.equal(read.status, 'ok');
      assert.equal(read.payload.vignettes[0].payload.scene, 'g64_original_taste_scene');

      // Non-empty precondition: derived index must actually contain the active projection before mutation.
      assert.ok(await evidenceStore.getByAnchor(derivedAnchor), 'precondition: derived anchor must exist');
      assert.equal(
        (await evidenceStore.search('g64_original_taste_scene', { limit: 5 })).length,
        1,
        'precondition: original scene must be searchable before mutation',
      );
      return { initial, snap, anchor };
    }

    it('correct invalidates non-empty derived index and stale cue, and canonical cue source serves updated scene', async () => {
      const { initial, snap: snap1, anchor } = await loadInitialEntryAndCue();

      const corrected = await postAction(initial.id, {
        action: 'correct',
        requestId: 'g64-taste-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: initial.revision,
        patch: { scene: 'g64_corrected_taste_scene_v2', tags: ['truth', 'corrected'] },
      });
      assert.equal(corrected.statusCode, 200, corrected.body);

      assert.deepEqual(await cueSource.read({ ownerUserId, anchor, expectedRevision: snap1.revision }), {
        status: 'not_available',
        invalidationReason: 'source_corrected',
      });
      assert.deepEqual(await evidenceStore.search('g64_original_taste_scene', { limit: 5 }), []);
      assert.equal(await evidenceStore.getByAnchor(derivedAnchor), null);

      const snap2 = await cueSource.resolve({
        ownerUserId,
        stage: 'review',
        selectedSkill: 'request-review',
        featureId: 'F321',
      });
      assert.ok(snap2);
      assert.notEqual(snap2.revision, snap1.revision);
      const read2 = await cueSource.read({ ownerUserId, anchor, expectedRevision: snap2.revision });
      assert.equal(read2.status, 'ok');
      assert.equal(read2.payload.vignettes[0].payload.scene, 'g64_corrected_taste_scene_v2');
    });

    it('retire from active state clears non-empty derived index and suppresses subsequent cue resolution', async () => {
      const { initial, snap, anchor } = await loadInitialEntryAndCue();

      const retired = await postAction(initial.id, {
        action: 'retire',
        requestId: 'g64-taste-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: initial.revision,
      });
      assert.equal(retired.statusCode, 200, retired.body);
      assert.equal(retired.json().status, 'retired');

      assert.equal(await evidenceStore.getByAnchor(derivedAnchor), null, 'retire must clear derived anchor');
      assert.deepEqual(await evidenceStore.search('g64_original_taste_scene', { limit: 5 }), []);
      assert.equal(
        await cueSource.resolve({
          ownerUserId,
          stage: 'review',
          selectedSkill: 'request-review',
          featureId: 'F321',
        }),
        null,
      );
      assert.deepEqual(await cueSource.read({ ownerUserId, anchor, expectedRevision: snap.revision }), {
        status: 'not_available',
        invalidationReason: 'source_forgotten',
      });
    });

    it('direct hard_forget from active state deletes canonical file, clears non-empty derived index, and blocks cue reads', async () => {
      const { initial, snap, anchor } = await loadInitialEntryAndCue();

      const forgotten = await postAction(initial.id, {
        action: 'hard_forget',
        requestId: 'g64-taste-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        expectedRevision: initial.revision,
        confirmed: true,
      });
      assert.equal(forgotten.statusCode, 200, forgotten.body);
      assert.equal(existsSync(join(root, sourcePath)), false);
      assert.equal(await evidenceStore.getByAnchor(derivedAnchor), null, 'hard_forget must clear derived anchor');
      assert.deepEqual(await evidenceStore.search('g64_original_taste_scene', { limit: 5 }), []);
      assert.equal(
        await cueSource.resolve({
          ownerUserId,
          stage: 'review',
          selectedSkill: 'request-review',
          featureId: 'F321',
        }),
        null,
      );
      assert.deepEqual(await cueSource.read({ ownerUserId, anchor, expectedRevision: snap.revision }), {
        status: 'not_available',
        invalidationReason: 'source_forgotten',
      });
    });
  });
});
