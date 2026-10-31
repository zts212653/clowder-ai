import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function vignette(label, dimension = 'visual-quality') {
  return `---
status: approved
when: "reviewing a user-facing interface"
quotes:
  - "${label}"
scene: "Use the approved constraint as evidence, not as an inferred rule."
tags:
  - review
dimension: ${dimension}
---
`;
}

function createTasteRoot(sourcePaths, extraCount = 0) {
  const root = mkdtempSync(join(tmpdir(), 'f316-taste-task-bundle-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  mkdirSync(join(root, 'private/taste'), { recursive: true });
  for (const sourcePath of sourcePaths) {
    writeFileSync(join(root, sourcePath), vignette(basename(sourcePath)));
  }
  for (let index = 0; index < extraCount; index += 1) {
    writeFileSync(join(root, `docs/taste/vignettes/unrelated-${index}.md`), vignette(`unrelated-${index}`));
  }
  return root;
}

function f315Input(overrides = {}) {
  return {
    ownerUserId: 'owner-1',
    stage: 'review',
    selectedSkill: 'request-review',
    featureId: 'F315',
    ...overrides,
  };
}

function f315Opportunity(overrides = {}) {
  return {
    v: 1,
    kind: 'judgment_surface_entered',
    opportunityId: 'f316-opportunity',
    producer: 'workflow_sop',
    consumer: 'agent_route',
    scope: { ownerUserId: 'owner-1', threadId: 'thread-f316', invocationId: 'invocation-f316' },
    occurredAt: 1_000,
    payload: {
      stage: 'review',
      selectedSkill: 'request-review',
      selectionSource: 'override',
      featureId: 'F315',
    },
    ...overrides,
  };
}

describe('F316 bounded Taste task bundle', () => {
  test('the named F315 consumer receives only exact approved refs and revisions', async () => {
    const { CanonicalTasteMemoryCueSource, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1 } = await import(
      '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js'
    );
    const root = createTasteRoot(F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths, 100);
    const source = new CanonicalTasteMemoryCueSource({ canonicalRoot: () => root }, 'owner-1');

    const bundle = await source.resolveTaskBundle(f315Input());

    assert.equal(bundle.bundleId, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.bundleId);
    assert.equal(bundle.consumerTaskRef, 'task:0001788513862645-000725-7abf9b0f');
    assert.deepEqual(
      bundle.sources.map(({ sourcePath }) => sourcePath),
      F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths,
    );
    assert.ok(bundle.sources.every(({ revision }) => /^sha256:[0-9a-f]{64}$/.test(revision)));
    assert.ok(bundle.sources.every(({ visibility }) => visibility === 'owner_public'));
    assert.ok(bundle.sources.every((item) => !Object.hasOwn(item, 'payload')));

    for (const nonMatch of [
      f315Input({ featureId: 'F314' }),
      f315Input({ stage: 'quality_gate' }),
      f315Input({ selectedSkill: 'fresh-context-review' }),
      f315Input({ ownerUserId: 'other-owner' }),
    ]) {
      assert.equal(await source.resolveTaskBundle(nonMatch), null);
    }

    const incompleteRoot = createTasteRoot(F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths.slice(0, -1));
    writeFileSync(
      join(incompleteRoot, 'docs/taste/vignettes/generic-fallback.md'),
      vignette('generic fallback must not mask a broken named bundle', 'architecture-aesthetics'),
    );
    const incompleteSource = new CanonicalTasteMemoryCueSource({ canonicalRoot: () => incompleteRoot }, 'owner-1');
    const { TasteCueResolver } = await import('../../dist/domains/memory/cue/resolvers/TasteCueResolver.js');
    assert.deepEqual(
      await new TasteCueResolver(incompleteSource).resolve(f315Opportunity(), {
        now: 1_001,
        expiresAt: 301_000,
        createDrillHandle: () => 'opaque-handle',
      }),
      [],
      'an unreadable named bundle must fail closed instead of falling back to the generic dimension map',
    );
  });

  test('resolver emits a fixed pointer bundle whose prompt size ignores unrelated Taste growth', async () => {
    const { CanonicalTasteMemoryCueSource, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1 } = await import(
      '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js'
    );
    const { TasteCueResolver } = await import('../../dist/domains/memory/cue/resolvers/TasteCueResolver.js');
    const { formatMemoryCues } = await import('../../dist/domains/memory/cue/format-memory-cues.js');
    const { getRecallOpportunityCatalogEntry } = await import(
      '../../dist/domains/memory/cue/RecallOpportunityCatalog.js'
    );
    const opportunity = f315Opportunity();
    const context = {
      now: 1_001,
      expiresAt: 301_000,
      createDrillHandle: ({ anchor, revision }) => `mch1.${anchor}.${revision}.${'x'.repeat(120)}`,
    };

    async function render(extraCount) {
      const root = createTasteRoot(F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths, extraCount);
      const source = new CanonicalTasteMemoryCueSource({ canonicalRoot: () => root }, 'owner-1');
      const cues = await new TasteCueResolver(source).resolve(opportunity, context);
      const entry = getRecallOpportunityCatalogEntry(opportunity);
      const formatted = formatMemoryCues(cues.slice(0, entry.maxCues), { maxTokens: entry.maxPromptTokens });
      return { cues, entry, formatted };
    }

    const baseline = await render(0);
    const grown = await render(100);

    assert.equal(baseline.cues.length, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths.length);
    assert.equal(baseline.entry.maxCues, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths.length);
    assert.equal(baseline.formatted.cues.length, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths.length);
    assert.equal(grown.formatted.cues.length, baseline.formatted.cues.length);
    assert.equal(grown.formatted.estimatedTokens, baseline.formatted.estimatedTokens);
    assert.deepEqual(
      grown.formatted.cues.map((cue) => [cue.source.anchor, cue.source.revision]),
      baseline.formatted.cues.map((cue) => [cue.source.anchor, cue.source.revision]),
    );
    assert.doesNotMatch(baseline.formatted.text, /Use the approved constraint as evidence/u);
    assert.match(baseline.formatted.text, /record applied\/dismissed/u);
    assert.match(baseline.formatted.text, /unconfirmed row in task evidence/u);
  });

  test('authenticated exact-ref drill rejects stale revisions and non-members', async () => {
    const { CanonicalTasteMemoryCueSource, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1, tasteTaskBundleAnchor } =
      await import('../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js');
    const root = createTasteRoot(F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths);
    const source = new CanonicalTasteMemoryCueSource({ canonicalRoot: () => root }, 'owner-1');
    const bundle = await source.resolveTaskBundle(f315Input());
    const selected = bundle.sources[0];
    const anchor = tasteTaskBundleAnchor(bundle.bundleId, selected.sourcePath);

    const drilled = await source.read({ ownerUserId: 'owner-1', anchor, expectedRevision: selected.revision });
    assert.equal(drilled.status, 'ok');
    assert.equal(drilled.payload.bundleId, bundle.bundleId);
    assert.equal(drilled.payload.consumerTaskRef, bundle.consumerTaskRef);
    assert.equal(drilled.payload.vignette.sourcePath, selected.sourcePath);
    assert.equal(
      (await source.read({ ownerUserId: 'other-owner', anchor, expectedRevision: selected.revision })).status,
      'not_available',
    );
    assert.equal(
      (
        await source.read({
          ownerUserId: 'owner-1',
          anchor: tasteTaskBundleAnchor(bundle.bundleId, 'docs/taste/vignettes/not-a-member.md'),
          expectedRevision: selected.revision,
        })
      ).status,
      'not_available',
    );

    writeFileSync(join(root, selected.sourcePath), vignette('corrected constraint'));
    assert.deepEqual(await source.read({ ownerUserId: 'owner-1', anchor, expectedRevision: selected.revision }), {
      status: 'not_available',
      invalidationReason: 'source_corrected',
    });
  });

  test('the named consumer drills and records each exact revision through callback auth', async () => {
    const [{ default: Database }, { default: Fastify }] = await Promise.all([
      import('better-sqlite3'),
      import('fastify'),
    ]);
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { MemoryCueDrillHandleService } = await import(
      '../../dist/domains/memory/cue/MemoryCueDrillHandleService.js'
    );
    const { registerCallbackMemoryCueRoutes } = await import('../../dist/routes/callback-memory-cue-routes.js');
    const { CanonicalTasteMemoryCueSource, F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1 } = await import(
      '../../dist/domains/memory/cue/sources/TasteMemoryCueSource.js'
    );
    const { TasteCueResolver } = await import('../../dist/domains/memory/cue/resolvers/TasteCueResolver.js');

    const root = createTasteRoot(F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1.sourcePaths);
    const source = new CanonicalTasteMemoryCueSource({ canonicalRoot: () => root }, 'owner-1');
    const scope = { ownerUserId: 'owner-1', threadId: 'thread-f315', invocationId: 'invocation-f315-review' };
    const opportunity = f315Opportunity({ opportunityId: 'f316-authenticated-consumer', scope });
    const expiresAt = 301_000;
    const cues = await new TasteCueResolver(source).resolve(opportunity, {
      now: 1_001,
      expiresAt,
      createDrillHandle: () => 'unused-direct-resolver-handle',
    });

    const db = new Database(':memory:');
    applyMigrations(db);
    const episodeStore = new MemoryCueEpisodeStore(db, { nowIso: () => '2026-09-04T20:00:00.000Z' });
    const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 9), episodeStore);
    const app = Fastify({ logger: false });
    app.decorateRequest('callbackAuth', undefined);
    app.addHook('preHandler', async (request) => {
      request.callbackAuth = {
        invocationId: scope.invocationId,
        callbackToken: 'callback-token',
        catId: 'codex-sol',
        threadId: scope.threadId,
        userId: scope.ownerUserId,
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt,
      };
    });
    registerCallbackMemoryCueRoutes(app, {
      episodeStore,
      handles,
      now: () => 1_001,
      sourceReader: {
        read(input) {
          return source.read({
            ownerUserId: input.scope.ownerUserId,
            anchor: input.anchor,
            expectedRevision: input.expectedRevision,
          });
        },
      },
    });
    await app.ready();

    try {
      for (const cue of cues) {
        const coordinate = {
          cueId: cue.cueId,
          opportunityId: cue.opportunityId,
          catalogVersion: cue.catalogVersion,
          resolverFamily: cue.resolverFamily,
          resolverVersion: cue.resolverVersion,
          family: 'taste',
          anchor: cue.source.anchor,
          revision: cue.source.revision,
          scope,
          consumerCatId: 'codex-sol',
          expiresAt,
        };
        episodeStore.append({
          eventId: `presented-${cue.cueId}`,
          idempotencyKey: `presented-${cue.cueId}`,
          cueId: cue.cueId,
          opportunityId: cue.opportunityId,
          scope,
          consumerCatId: 'codex-sol',
          resolverFamily: cue.resolverFamily,
          sourceAnchor: cue.source.anchor,
          sourceRevision: cue.source.revision,
          axis: 'consumption',
          consumptionOutcome: 'presented',
          catalogVersion: cue.catalogVersion,
          resolverVersion: cue.resolverVersion,
          occurredAt: opportunity.occurredAt,
        });
        const handle = handles.issue(coordinate);
        const drill = await app.inject({
          method: 'POST',
          url: '/api/callbacks/memory-cues/drill',
          payload: { handle, requestId: `drill-${cue.cueId}` },
        });
        assert.equal(drill.statusCode, 200);
        assert.equal(drill.json().payload.vignette.revision, cue.source.revision);
        const outcome = await app.inject({
          method: 'POST',
          url: '/api/callbacks/memory-cues/outcome',
          payload: { handle, outcome: 'applied', requestId: `apply-${cue.cueId}` },
        });
        assert.equal(outcome.statusCode, 200);
        assert.deepEqual(
          episodeStore.listByCue(scope.ownerUserId, cue.cueId).map((event) => event.consumptionOutcome),
          ['presented', 'drilled', 'applied'],
        );
      }
    } finally {
      await app.close();
      db.close();
    }
  });
});
