import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadDossierSnapshot } from '@cat-cafe/shared/dossier';
import {
  fixture,
  ownerId,
  primaryCatId,
  profile,
  secondaryCatId,
  writeDossier,
} from './helpers/routing-dossier-composition-fixture.js';

describe('F293 routing dossier diagnostics', () => {
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
