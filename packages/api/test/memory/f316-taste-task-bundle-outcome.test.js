import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const SCOPE = {
  ownerUserId: 'owner-1',
  threadId: 'thread-f315',
  invocationId: 'invocation-f315-review',
};
const SOURCE_PATH = 'docs/taste/vignettes/visual-quality-用户视角-qebr8h.md';
const SOURCE_ANCHOR = `taste-task-bundle:f315-workspace-readability-review-v1#${SOURCE_PATH}`;

function coordinate(cueId) {
  return {
    cueId,
    opportunityId: 'f316-task-bundle-outcome',
    catalogVersion: 5,
    resolverFamily: 'taste',
    resolverVersion: 3,
    family: 'taste',
    anchor: SOURCE_ANCHOR,
    revision: 'sha256:task-bundle-revision',
    scope: SCOPE,
    consumerCatId: 'codex-sol',
    expiresAt: 5_000,
  };
}

function present(episodeStore, input) {
  episodeStore.append({
    eventId: `presented-${input.cueId}`,
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
}

async function createHarness() {
  const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
  const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
  const { MemoryCueDrillHandleService } = await import('../../dist/domains/memory/cue/MemoryCueDrillHandleService.js');
  const { registerCallbackMemoryCueRoutes } = await import('../../dist/routes/callback-memory-cue-routes.js');

  const db = new Database(':memory:');
  applyMigrations(db);
  const episodeStore = new MemoryCueEpisodeStore(db, { nowIso: () => '2026-09-04T20:00:00.000Z' });
  const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 11), episodeStore);
  const correctedAnchors = new Set();
  const sourceReads = [];
  const app = Fastify({ logger: false });
  app.decorateRequest('callbackAuth', undefined);
  app.addHook('preHandler', async (request) => {
    request.callbackAuth = {
      invocationId: SCOPE.invocationId,
      callbackToken: 'callback-token',
      catId: 'codex-sol',
      threadId: SCOPE.threadId,
      userId: SCOPE.ownerUserId,
      clientMessageIds: new Set(),
      createdAt: 0,
      expiresAt: 10_000,
    };
  });
  registerCallbackMemoryCueRoutes(app, {
    episodeStore,
    handles,
    now: () => 1_000,
    sourceReader: {
      read(input) {
        sourceReads.push(input);
        if (correctedAnchors.has(input.anchor)) {
          return { status: 'not_available', invalidationReason: 'source_corrected' };
        }
        return {
          status: 'ok',
          payload: {
            bundleId: 'f315-workspace-readability-review-v1',
            consumerTaskRef: 'task:0001788513862645-000725-7abf9b0f',
            vignette: { sourcePath: SOURCE_PATH, revision: input.expectedRevision },
          },
        };
      },
    },
  });
  await app.ready();
  return { app, correctedAnchors, db, episodeStore, handles, sourceReads };
}

describe('F316 Taste task-bundle application evidence', () => {
  test('requires same-scope drill while preserving exact applied-request idempotency', async () => {
    const harness = await createHarness();
    const { app, correctedAnchors, db, episodeStore, handles, sourceReads } = harness;
    try {
      const input = coordinate('cue-task-bundle-application');
      present(episodeStore, input);
      const handle = handles.issue(input);
      const outcomePayload = { handle, outcome: 'applied', requestId: 'apply-task-bundle' };

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
        payload: { handle, requestId: 'drill-task-bundle' },
      });
      assert.equal(drill.statusCode, 200);
      const applied = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: outcomePayload,
      });
      assert.equal(applied.statusCode, 200);
      assert.deepEqual(applied.json(), { status: 'recorded', outcome: 'applied' });

      correctedAnchors.add(input.anchor);
      const readsBeforeRetry = sourceReads.length;
      const exactRetry = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: outcomePayload,
      });
      assert.equal(exactRetry.statusCode, 200);
      assert.equal(sourceReads.length, readsBeforeRetry, 'exact committed retry must not re-read current source');
    } finally {
      await app.close();
      db.close();
    }
  });

  test('re-reads and rejects a corrected source after drill before a new applied receipt', async () => {
    const harness = await createHarness();
    const { app, correctedAnchors, db, episodeStore, handles, sourceReads } = harness;
    try {
      const input = coordinate('cue-task-bundle-corrected');
      present(episodeStore, input);
      const handle = handles.issue(input);
      const drill = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/drill',
        payload: { handle, requestId: 'drill-before-correction' },
      });
      assert.equal(drill.statusCode, 200);

      correctedAnchors.add(input.anchor);
      const applied = await app.inject({
        method: 'POST',
        url: '/api/callbacks/memory-cues/outcome',
        payload: { handle, outcome: 'applied', requestId: 'apply-after-correction' },
      });
      assert.equal(applied.statusCode, 404);
      assert.deepEqual(applied.json(), { error: 'not_available' });
      assert.equal(sourceReads.length, 2, 'drill and new applied must each read the canonical source');
      assert.deepEqual(
        episodeStore
          .listByCue(SCOPE.ownerUserId, input.cueId)
          .map((event) => [event.axis, event.consumptionOutcome, event.invalidationReason]),
        [
          ['consumption', 'presented', null],
          ['consumption', 'drilled', null],
          ['invalidation', null, 'source_corrected'],
        ],
      );
    } finally {
      await app.close();
      db.close();
    }
  });
});
