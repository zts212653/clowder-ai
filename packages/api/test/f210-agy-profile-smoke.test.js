import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildDefaultAgyProfileSmokeTargets, parseAgyProfileSmokeArgs, summarizeAgyProfileSmokeEvents } = await import(
  '../dist/scripts/f210-agy-profile-smoke.js'
);

describe('F210 AGY profile E2E smoke runner', () => {
  test('default target set covers Opus, Gemini 3.1 Pro, and Gemini 3.5 Flash selector labels', () => {
    const targets = buildDefaultAgyProfileSmokeTargets();

    assert.deepEqual(
      targets.map((target) => target.modelLabel),
      ['Claude Opus 4.6 (Thinking)', 'Gemini 3.1 Pro (High)', 'Gemini 3.5 Flash (High)'],
    );
    assert.equal(new Set(targets.map((target) => target.profileId)).size, 3);
    assert.equal(new Set(targets.map((target) => target.marker)).size, 3);
    assert.ok(targets.every((target) => target.marker.startsWith('CAT_CAFE_AGY_PROFILE_SMOKE_OK_')));
  });

  test('summarizes a profile run as passed only when the marker and verified model both match', () => {
    const target = buildDefaultAgyProfileSmokeTargets()[2];
    const result = summarizeAgyProfileSmokeEvents(target, [
      {
        type: 'text',
        catId: target.catId,
        content: ` ${target.marker} `,
        metadata: { provider: 'google', model: `${target.modelLabel} (antigravity-cli profile)`, modelVerified: true },
      },
      {
        type: 'done',
        catId: target.catId,
        metadata: { provider: 'google', model: `${target.modelLabel} (antigravity-cli profile)`, modelVerified: true },
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.stage, 'passed');
    assert.equal(result.observedModel, target.modelLabel);
    assert.equal(result.markerMatched, true);
  });

  test('rejects marker responses with extra prose', () => {
    const target = buildDefaultAgyProfileSmokeTargets()[1];
    const result = summarizeAgyProfileSmokeEvents(target, [
      {
        type: 'text',
        catId: target.catId,
        content: `${target.marker}\n\nReady when you are.`,
        metadata: { provider: 'google', model: `${target.modelLabel} (antigravity-cli profile)`, modelVerified: true },
      },
      {
        type: 'done',
        catId: target.catId,
        metadata: { provider: 'google', model: `${target.modelLabel} (antigravity-cli profile)`, modelVerified: true },
      },
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'marker_missing');
    assert.equal(result.markerMatched, false);
  });

  test('detects sticky-state bleed when a profile reports another target model', () => {
    const [opus, gemini31] = buildDefaultAgyProfileSmokeTargets();
    const result = summarizeAgyProfileSmokeEvents(opus, [
      {
        type: 'text',
        catId: opus.catId,
        content: opus.marker,
        metadata: {
          provider: 'google',
          model: `${gemini31.modelLabel} (antigravity-cli profile)`,
          modelVerified: false,
        },
      },
      {
        type: 'done',
        catId: opus.catId,
        metadata: {
          provider: 'google',
          model: `${gemini31.modelLabel} (antigravity-cli profile)`,
          modelVerified: false,
        },
      },
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'model_mismatch');
    assert.equal(result.observedModel, gemini31.modelLabel);
  });

  test('summarizes auth-required errors without leaking OAuth URLs', () => {
    const target = buildDefaultAgyProfileSmokeTargets()[0];
    const result = summarizeAgyProfileSmokeEvents(target, [
      {
        type: 'error',
        catId: target.catId,
        error:
          'Antigravity CLI profile is not authenticated. Run `agy` with the same HOME/profile and complete login before unattended Clowder AI use.',
        metadata: { provider: 'google', model: `${target.modelLabel} (antigravity-cli profile)`, modelVerified: false },
      },
      {
        type: 'done',
        catId: target.catId,
        metadata: { provider: 'google', model: `${target.modelLabel} (antigravity-cli profile)`, modelVerified: false },
      },
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'auth_required');
    assert.doesNotMatch(JSON.stringify(result), /accounts\.google\.com/);
  });

  test('CLI parser keeps live execution opt-in', () => {
    assert.equal(parseAgyProfileSmokeArgs([]).runLive, false);
    assert.deepEqual(
      parseAgyProfileSmokeArgs(['--run-live', '--home-root=/tmp/agy', '--working-directory', '/tmp/wt']),
      {
        runLive: true,
        homeRoot: '/tmp/agy',
        workingDirectory: '/tmp/wt',
        outputJson: undefined,
      },
    );
    assert.equal(parseAgyProfileSmokeArgs(['--', '--run-live']).runLive, true);
  });
});
