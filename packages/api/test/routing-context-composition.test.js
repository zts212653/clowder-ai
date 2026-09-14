import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { _resetDossierCache, loadDossierSnapshot } from '@cat-cafe/shared/dossier';

const { createRoutingContextRuntime } = await import('../dist/domains/routing-context/RoutingContextRuntime.js');
const ownerId = 'issue-1438-owner';
const primaryCatId = 'issue-1438-primary';
const secondaryCatId = 'issue-1438-secondary';
const missingModelCatId = 'issue-1438-missing-model';
const member = (id, defaultModel = 'test-model') => ({
  id,
  name: id,
  displayName: id,
  avatar: 'test',
  color: { primary: '#000', secondary: '#fff' },
  mentionPatterns: [],
  mcpSupport: false,
  roleDescription: 'Local test member',
  personality: 'test',
  clientId: 'openai',
  defaultModel,
});
const configs = {
  [primaryCatId]: member(primaryCatId),
  [secondaryCatId]: member(secondaryCatId),
};
for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
catRegistry.register(missingModelCatId, { ...member(missingModelCatId), defaultModel: undefined });

function fixture(t, { signals = [], preferences = [], members = configs } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'routing-composition-1438-'));
  t.after(() => {
    _resetDossierCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  const runtime = createRoutingContextRuntime({ redis: {}, projectRoot, getConfigs: () => members });
  // Keep the production catalog/resolver/profile/preflight wiring; isolate only storage I/O.
  t.mock.method(runtime.signalStore, 'getOwnerRevision', async () => signals.length);
  t.mock.method(runtime.signalStore, 'listByOwner', async () => signals);
  t.mock.method(runtime.preferenceStore, 'listByOwner', async () => preferences);
  return { runtime, projectRoot };
}

function writeDossier(projectRoot, content) {
  const directory = join(projectRoot, 'docs', 'team');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'cat-dossier.md');
  writeFileSync(path, content);
  return path;
}

function profile(catId) {
  return `# Local dossier\n\n\`\`\`yaml\n# structured-profile: cat:${catId}\nentityId: "cat:${catId}"\noneLiner: "Local member"\n\`\`\`\n`;
}

async function assertDegraded(runtime, reason, targetCatId = primaryCatId) {
  const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
  assert.equal(read.resolution.state, 'degraded');
  assert.equal(read.resolution.reason, reason);
  const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [targetCatId] });
  assert.equal(decision.resolverState, 'degraded');
  assert.equal(decision.targets[0].disposition, 'warned');
  assert.equal(decision.targets[0].reasons[0].code, 'routing_context_unavailable');
  assert.deepEqual(decision.targets[0].reasons[0].sourceRefs, [`routing-context:resolver_degraded:${reason}`]);
}

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

  for (const [label, fields] of [
    ['unquoted Chinese colon', 'oneLiner: 深度推理: 系统设计'],
    ['tab indentation', 'routingSignals:\n\tpeakCapabilities: ["reasoning"]'],
    ['bare @ handle', 'handle: @secondary'],
    ['unclosed flow sequence', 'routingSignals:\n  peakCapabilities: ["reasoning"'],
    ['unclosed flow mapping', 'provenance: { version: "1"'],
    ['unclosed quoted scalar', 'oneLiner: "unterminated'],
    ['duplicate key', 'oneLiner: "first"\noneLiner: "second"'],
  ]) {
    test(`retains an applied profile and traceable ${label} diagnostic while unavailable still wins`, async (t) => {
      const now = Date.now();
      const primarySignal = {
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
      };
      const signals = [primarySignal];
      const { runtime, projectRoot } = fixture(t, { signals });
      const tolerant = [
        '```yaml',
        `# structured-profile: cat:${secondaryCatId}`,
        `entityId: "cat:${secondaryCatId}"`,
        fields,
        '```',
      ].join('\n');
      writeDossier(projectRoot, `${profile(primaryCatId)}\n${tolerant}\n`);
      const read = await runtime.readService.read({ ownerId, observedAt: now });
      assert.equal(read.resolution.state, 'fresh');
      const secondary = read.resolution.snapshot.candidates.find((cat) => cat.binding.catId === secondaryCatId);
      assert.equal(secondary.profile.state, 'applied');
      assert.equal(secondary.availability, 'available');
      assert.equal(secondary.effect, 'eligible');
      const diagnostic = secondary.reasons.find((reason) => reason.code === 'capability_profile_invalid');
      assert.ok(diagnostic);
      assert.match(diagnostic.summary, /invalid_yaml/);
      assert.ok(diagnostic.sourceRefs.some((ref) => /docs\/team\/cat-dossier\.md#L10$/.test(ref)));
      const decision = await runtime.dispatchPreflight.preflight({
        ownerId,
        targetCatIds: [primaryCatId, secondaryCatId],
      });
      assert.equal(decision.targets[0].disposition, 'rejected');
      assert.deepEqual(
        decision.targets[0].alternatives.map((candidate) => candidate.catId),
        [secondaryCatId],
      );
      assert.equal(decision.targets[1].disposition, 'warned');
      assert.ok(decision.targets[1].reasons.some((reason) => reason.code === 'capability_profile_invalid'));
      assert.match(await runtime.promptProjection.resolve({ ownerId }), /invalid_yaml/);

      signals.push({
        ...primarySignal,
        eventId: 'secondary-down',
        commandId: 'mark-secondary-down',
        subjectRef: { type: 'cat', catId: secondaryCatId },
      });
      const unavailable = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [secondaryCatId] });
      assert.equal(unavailable.resolverState, 'fresh');
      assert.equal(unavailable.targets[0].disposition, 'rejected');
      assert.ok(unavailable.targets[0].reasons.some((reason) => reason.code === 'routing_signal_unavailable'));
      assert.ok(unavailable.targets[0].reasons.some((reason) => reason.code === 'capability_profile_invalid'));
      assert.deepEqual(unavailable.targets[0].alternatives, []);
    });
  }

  for (const [label, fatal] of [
    ['missing identity', profile(secondaryCatId).replace(`entityId: "cat:${secondaryCatId}"`, '')],
    [
      'nested identity',
      profile(secondaryCatId).replace(
        `entityId: "cat:${secondaryCatId}"`,
        `identity:\n  entityId: "cat:${secondaryCatId}"`,
      ),
    ],
    [
      'marker mismatch',
      profile(secondaryCatId).replace(`entityId: "cat:${secondaryCatId}"`, `entityId: "cat:${primaryCatId}"`),
    ],
  ]) {
    for (const tolerant of [false, true]) {
      for (const fatalFirst of [false, true]) {
        test(`keeps ${label} routing-fatal without mutating roster data (tolerant=${tolerant}, fatalFirst=${fatalFirst})`, async (t) => {
          const { runtime, projectRoot } = fixture(t);
          const usable = tolerant
            ? profile(secondaryCatId).replace(
                'oneLiner: "Local member"',
                'oneLiner: "Local member"\nhandle: @secondary',
              )
            : profile(secondaryCatId);
          const blocks = fatalFirst ? [fatal, usable] : [usable, fatal];
          writeDossier(projectRoot, [profile(primaryCatId), ...blocks].join('\n'));
          const dossier = loadDossierSnapshot(projectRoot);
          assert.equal(dossier.state, 'loaded');
          assert.ok(dossier.profiles.has(secondaryCatId), 'the upstream roster projection stays tolerant');
          const roster = structuredClone([...dossier.profiles]);
          const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
          assert.equal(read.resolution.state, 'fresh');
          const secondary = read.resolution.snapshot.candidates.find(
            (candidate) => candidate.binding.catId === secondaryCatId,
          );
          assert.equal(secondary.profile.state, 'absent');
          assert.equal(secondary.availability, 'available');
          assert.match(secondary.reasons[0].summary, /invalid_identity/);
          assert.ok(secondary.reasons[0].sourceRefs.every((ref) => /cat-dossier\.md#L\d+$/.test(ref)));
          const decision = await runtime.dispatchPreflight.preflight({
            ownerId,
            targetCatIds: [secondaryCatId, 'not-in-catalog'],
          });
          assert.equal(decision.targets[0].disposition, 'warned');
          assert.deepEqual(
            decision.targets[1].alternatives.map((candidate) => candidate.catId),
            [primaryCatId],
          );
          assert.equal(loadDossierSnapshot(projectRoot).profiles, dossier.profiles);
          assert.deepEqual([...dossier.profiles], roster);
        });
      }
    }
  }

  for (const fields of ['', '\noneLiner: "Literal ``` data"']) {
    test(`an unterminated repeated block invalidates routing without revoking its prior roster projection: ${fields}`, async (t) => {
      const { runtime, projectRoot } = fixture(t);
      const unclosed = [
        '```yaml',
        `# structured-profile: cat:${secondaryCatId}`,
        `entityId: "cat:${secondaryCatId}"${fields}`,
      ].join('\n');
      writeDossier(projectRoot, profile(primaryCatId) + profile(secondaryCatId) + unclosed);
      const roster = loadDossierSnapshot(projectRoot).profiles;
      assert.ok(roster.has(secondaryCatId));
      const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
      assert.equal(read.resolution.state, 'fresh');
      assert.equal(read.resolution.snapshot.candidates[1].profile.state, 'absent');
      assert.match(read.resolution.snapshot.candidates[1].reasons[0].summary, /unclosed_block/);
      assert.equal(loadDossierSnapshot(projectRoot).profiles, roster);
      assert.ok(roster.has(secondaryCatId));
    });
  }

  for (const kind of ['duplicate_profile', 'invalid_yaml']) {
    test(`clears ${kind} after repair even when the projected profile hash is unchanged`, async (t) => {
      const { runtime, projectRoot } = fixture(t);
      const valid = profile(secondaryCatId);
      const before =
        kind === 'duplicate_profile'
          ? valid + valid
          : valid.replace('oneLiner: "Local member"', 'oneLiner: "Local member"\nhandle: @secondary');
      const after = kind === 'duplicate_profile' ? valid : before.replace('handle: @secondary', 'handle: "@secondary"');
      writeDossier(projectRoot, profile(primaryCatId) + before);
      const input = { ownerId, observedAt: 10_000 };
      const first = await runtime.readService.read(input);
      assert.equal(first.resolution.state, 'fresh');
      assert.equal(first.resolution.snapshot.candidates[1].profile.state, 'applied');
      assert.match(first.resolution.snapshot.candidates[1].reasons[0].summary, new RegExp(kind));
      assert.equal(
        (await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [secondaryCatId] })).targets[0].disposition,
        'warned',
      );
      writeDossier(projectRoot, profile(primaryCatId) + after);
      const second = await runtime.readService.read(input);
      assert.equal(second.resolution.state, 'fresh');
      assert.equal(
        second.resolution.snapshot.candidates[1].profile.revision.dossierRevision,
        first.resolution.snapshot.candidates[1].profile.revision.dossierRevision,
      );
      assert.notEqual(second.resolution.inputRevisionRef, first.resolution.inputRevisionRef);
      assert.deepEqual(second.resolution.snapshot.candidates[1].reasons, []);
      assert.equal(
        (await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [secondaryCatId] })).targets[0].disposition,
        'allowed',
      );
    });
  }

  test('restores routing after a fatal duplicate is removed while preserving every roster snapshot', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    const valid = profile(primaryCatId) + profile(secondaryCatId);
    const fatal = profile(secondaryCatId).replace(`entityId: "cat:${secondaryCatId}"`, '');
    const input = { ownerId, observedAt: 10_000 };
    writeDossier(projectRoot, valid);
    const initialRoster = loadDossierSnapshot(projectRoot).profiles;
    const initial = await runtime.readService.read(input);
    writeDossier(projectRoot, valid + fatal);
    const brokenRoster = loadDossierSnapshot(projectRoot).profiles;
    assert.ok(brokenRoster.has(secondaryCatId));
    const broken = await runtime.readService.read(input);
    assert.equal(broken.resolution.snapshot.candidates[1].profile.state, 'absent');
    assert.ok(brokenRoster.has(secondaryCatId));
    writeDossier(projectRoot, valid);
    const repaired = await runtime.readService.read(input);
    assert.equal(repaired.resolution.snapshot.candidates[1].profile.state, 'applied');
    assert.deepEqual(repaired.resolution.snapshot.candidates[1].reasons, []);
    assert.equal(repaired.resolution.inputRevisionRef, initial.resolution.inputRevisionRef);
    assert.deepEqual([...brokenRoster], [...initialRoster]);
  });

  test('clears a removed malformed record diagnostic and refreshes its source revision', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    writeDossier(
      projectRoot,
      `${profile(primaryCatId)}\n\`\`\`yaml\n# structured-profile: cat:${secondaryCatId}\n\`\`\`\n`,
    );
    const input = { ownerId, observedAt: 10_000 };
    const first = await runtime.readService.read(input);
    assert.equal(first.resolution.state, 'fresh');
    assert.ok(
      first.resolution.snapshot.candidates[1].reasons.some((reason) => reason.code === 'capability_profile_invalid'),
    );
    writeDossier(projectRoot, profile(primaryCatId));
    const second = await runtime.readService.read(input);
    assert.equal(second.resolution.state, 'fresh');
    assert.equal(second.resolution.snapshot.candidates[1].profile.state, 'absent');
    assert.deepEqual(second.resolution.snapshot.candidates[1].reasons, []);
    assert.notEqual(first.resolution.inputRevisionRef, second.resolution.inputRevisionRef);
    const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [secondaryCatId] });
    assert.equal(decision.targets[0].disposition, 'allowed');
  });

  test('bounds repeated malformed-record diagnostics without degrading valid peers', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    const badBlock = `\`\`\`yaml\n# structured-profile: cat:${secondaryCatId}\n\`\`\`\n`;
    writeDossier(projectRoot, profile(primaryCatId) + badBlock.repeat(40));
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.equal(read.resolution.snapshot.candidates[0].profile.state, 'applied');
    const reasons = read.resolution.snapshot.candidates[1].reasons;
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].code, 'capability_profile_invalid');
    assert.ok(reasons[0].sourceRefs.length > 0 && reasons[0].sourceRefs.length <= 32);
    const decision = await runtime.dispatchPreflight.preflight({
      ownerId,
      targetCatIds: [primaryCatId, secondaryCatId],
    });
    assert.deepEqual(
      decision.targets.map((target) => target.disposition),
      ['allowed', 'warned'],
    );
    assert.deepEqual(
      decision.targets[1].alternatives.map((candidate) => candidate.catId),
      [primaryCatId],
    );
  });

  test('keeps the only projected profile usable with a syntax diagnostic and excludes ordinary absence from alternatives', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    writeDossier(
      projectRoot,
      profile(primaryCatId).replace('oneLiner: "Local member"', 'routingSignals:\n  peakCapabilities: ["reasoning"'),
    );
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.equal(read.resolution.snapshot.candidates[0].profile.state, 'applied');
    assert.equal(read.resolution.snapshot.candidates[1].profile.state, 'absent');
    const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [primaryCatId] });
    assert.equal(decision.targets[0].disposition, 'warned');
    assert.match(decision.targets[0].reasons[0].summary, /invalid_yaml/);
    assert.deepEqual(decision.targets[0].alternatives, []);
  });

  test('clears a syntax diagnostic after the same record is repaired', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    const malformed = profile(secondaryCatId).replace(
      'oneLiner: "Local member"',
      'routingSignals:\n  peakCapabilities: ["reasoning"',
    );
    writeDossier(projectRoot, profile(primaryCatId) + malformed);
    const input = { ownerId, observedAt: 10_000 };
    const first = await runtime.readService.read(input);
    assert.equal(first.resolution.state, 'fresh');
    assert.equal(first.resolution.snapshot.candidates[1].profile.state, 'applied');
    assert.match(first.resolution.snapshot.candidates[1].reasons[0].summary, /invalid_yaml/);
    writeDossier(projectRoot, profile(primaryCatId) + malformed.replace('["reasoning"', '["reasoning"]'));
    const second = await runtime.readService.read(input);
    assert.equal(second.resolution.state, 'fresh');
    assert.equal(second.resolution.snapshot.candidates[1].profile.state, 'applied');
    assert.ok(
      second.resolution.snapshot.candidates[1].reasons.every((reason) => reason.code !== 'capability_profile_invalid'),
    );
    assert.notEqual(first.resolution.inputRevisionRef, second.resolution.inputRevisionRef);
    const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [secondaryCatId] });
    assert.equal(decision.targets[0].disposition, 'allowed');
  });
});
