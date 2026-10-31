import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  assertDegraded,
  createRoutingContextRuntime,
  fixture,
  missingModelCatId,
  ownerId,
  primaryCatId,
  profile,
  secondaryCatId,
  writeDossier,
} from './helpers/routing-dossier-composition-fixture.js';

describe('F293 routing context composition', () => {
  test('binds owner reads, writes and preflight to one resolver/store graph', async () => {
    const redis = {};
    const runtime = createRoutingContextRuntime({ redis, projectRoot: process.cwd(), getConfigs: () => ({}) });
    assert.equal(runtime.signalStore.redis, redis);
    assert.equal(runtime.preferenceStore.redis, redis);
    assert.equal(runtime.resolver.dependencies.signalStore, runtime.signalStore);
    assert.equal(runtime.resolver.dependencies.preferenceStore, runtime.preferenceStore);
    assert.equal(runtime.readService.dependencies.resolver, runtime.resolver);
    assert.equal(runtime.preflightService.resolver, runtime.resolver);
    assert.ok(runtime.promptProjector);
    assert.ok(runtime.promptProjection);
  });

  test('allows repeated sends with candidate-local absent profiles when the installation has no dossier', async (t) => {
    const { runtime } = fixture(t);
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.deepEqual(
      read.resolution.snapshot.candidates.map((candidate) => [candidate.binding.catId, candidate.profile]),
      [
        [primaryCatId, { state: 'absent' }],
        [secondaryCatId, { state: 'absent' }],
      ],
    );
    await assert.doesNotReject(runtime.promptProjection.resolve({ ownerId }));
    for (let send = 0; send < 2; send++) {
      const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [primaryCatId] });
      assert.equal(decision.resolverState, 'fresh');
      assert.equal(decision.targets[0].disposition, 'allowed');
      assert.deepEqual(decision.targets[0].reasons, []);
    }
  });

  test('preserves owner routing preferences without requiring a dossier', async (t) => {
    const preference = {
      v: 1,
      ownerId,
      preferenceId: 'local-review-order',
      revisionId: 'local-review-order-v1',
      commandId: 'set-local-review-order',
      appliesWhen: { intent: 'review' },
      prefer: [{ type: 'cat', catId: secondaryCatId }],
      over: [{ type: 'cat', catId: primaryCatId }],
      rationale: 'Use the locally configured review order.',
      evidenceRefs: ['test:operator-preference'],
      version: 1,
      validFrom: 1,
      lifecycle: 'active',
    };
    const { runtime } = fixture(t, { preferences: [preference] });
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now(), intent: 'review' });
    assert.equal(read.resolution.state, 'fresh');
    assert.deepEqual(
      read.resolution.snapshot.candidates.map((candidate) => candidate.binding.catId),
      [secondaryCatId, primaryCatId],
    );
    assert.deepEqual(read.resolution.snapshot.candidates[0].matchedPreferences, [
      { revisionId: preference.revisionId, lifecycle: 'active' },
    ]);
  });

  test('rejects a genuinely unavailable member even when the installation has no dossier', async (t) => {
    const now = Date.now();
    const signal = {
      v: 1,
      ownerId,
      eventId: 'local-member-unavailable',
      commandId: 'mark-local-member-unavailable',
      subjectRef: { type: 'cat', catId: primaryCatId },
      reasonCode: 'provider_unreachable',
      source: 'health_probe',
      observedAt: now,
      evidenceRef: 'test:health-probe',
      eventType: 'asserted',
      state: 'unavailable',
      validUntil: now + 60_000,
    };
    const { runtime } = fixture(t, { signals: [signal] });
    const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [primaryCatId] });
    assert.equal(decision.resolverState, 'fresh');
    assert.equal(decision.targets[0].disposition, 'rejected');
    assert.ok(decision.targets[0].reasons.some((reason) => reason.code === 'routing_signal_unavailable'));
    assert.deepEqual(decision.targets[0].alternatives, [], 'members without applied profiles are not alternatives');
  });

  test('keeps an existing but unreadable dossier globally degraded', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    // A directory at the file path produces a deterministic read failure even when tests run as root.
    mkdirSync(join(projectRoot, 'docs', 'team', 'cat-dossier.md'), { recursive: true });
    await assertDegraded(runtime, 'dossier_unreadable_or_empty');
  });

  test('keeps an existing but unparseable dossier globally degraded', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    writeDossier(
      projectRoot,
      `\`\`\`yaml\n# structured-profile: cat:${primaryCatId}\nentityId: "unterminated\n\`\`\`\n`,
    );
    await assertDegraded(runtime, 'dossier_unreadable_or_empty');
  });

  test('keeps an applied profile with a missing model contract globally degraded', async (t) => {
    const { runtime, projectRoot } = fixture(t, {
      members: { [missingModelCatId]: catRegistry.getOrThrow(missingModelCatId).config },
    });
    writeDossier(projectRoot, profile(missingModelCatId));
    await assertDegraded(runtime, 'model_missing', missingModelCatId);
  });

  test('does not hide a missing model contract behind a tolerated syntax diagnostic', async (t) => {
    const { runtime, projectRoot } = fixture(t, {
      members: { [missingModelCatId]: catRegistry.getOrThrow(missingModelCatId).config },
    });
    writeDossier(projectRoot, profile(missingModelCatId).replace('oneLiner: "Local member"', 'handle: @local'));
    await assertDegraded(runtime, 'model_missing', missingModelCatId);
  });

  test('observes a locally created dossier after an initially absent profile without restarting', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    const first = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(first.resolution.state, 'fresh');
    assert.equal(first.resolution.snapshot.candidates[0].profile.state, 'absent');
    writeDossier(projectRoot, profile(primaryCatId));
    const second = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(second.resolution.state, 'fresh');
    assert.equal(second.resolution.snapshot.candidates[0].profile.state, 'applied');
    assert.equal(second.resolution.snapshot.candidates[0].profile.revision.modelId, 'test-model');
    assert.equal(second.resolution.snapshot.candidates[1].profile.state, 'absent');
  });

  for (const [label, identity, closingFence] of [
    ['missing identity', '', '```'],
    ['malformed identity', 'entityId: "unterminated', '```'],
    ['mismatched identity', `entityId: "cat:${primaryCatId}"`, '```'],
    ['unclosed block', `entityId: "cat:${secondaryCatId}"`, ''],
  ]) {
    test(`diagnoses ${label} beside a valid peer without hiding unavailable signals`, async (t) => {
      const now = Date.now();
      const { runtime, projectRoot } = fixture(t, {
        signals: [
          {
            v: 1,
            ownerId,
            eventId: 'primary-down',
            commandId: 'mark-primary-down',
            subjectRef: { type: 'cat', catId: primaryCatId },
            reasonCode: 'provider_unreachable',
            source: 'health_probe',
            observedAt: now,
            evidenceRef: 'test:health',
            eventType: 'asserted',
            state: 'unavailable',
            validUntil: now + 60_000,
          },
        ],
      });
      const malformed = ['```yaml', `# structured-profile: cat:${secondaryCatId}`, identity, closingFence].join('\n');
      writeDossier(projectRoot, `${profile(primaryCatId)}\n${malformed}\n`);
      const read = await runtime.readService.read({ ownerId, observedAt: now });
      assert.equal(read.resolution.state, 'fresh');
      const primary = read.resolution.snapshot.candidates.find((cat) => cat.binding.catId === primaryCatId);
      const secondary = read.resolution.snapshot.candidates.find((cat) => cat.binding.catId === secondaryCatId);
      assert.equal(primary.profile.state, 'applied');
      const diagnostic = secondary.reasons.find((reason) => reason.code === 'capability_profile_invalid');
      assert.ok(diagnostic, 'marked malformed records must not silently become ordinary absence');
      assert.ok(diagnostic.sourceRefs.some((ref) => /docs\/team\/cat-dossier\.md#L\d+/.test(ref)));
      assert.equal(secondary.profile.state, 'absent');
      assert.equal(secondary.effect, 'eligible', 'availability effect retains its existing signal-only contract');
      assert.equal(secondary.availability, 'available', 'profile errors do not invent provider outages');
      const decision = await runtime.dispatchPreflight.preflight({
        ownerId,
        targetCatIds: [primaryCatId, secondaryCatId],
      });
      assert.equal(decision.resolverState, 'fresh');
      assert.equal(decision.targets[0].disposition, 'rejected');
      assert.deepEqual(decision.targets[0].alternatives, []);
      assert.equal(decision.targets[1].disposition, 'warned');
      assert.ok(decision.targets[1].reasons.some((reason) => reason.code === 'capability_profile_invalid'));
      assert.match(await runtime.promptProjection.resolve({ ownerId }), /capability_profile_invalid/);
    });
  }
});
