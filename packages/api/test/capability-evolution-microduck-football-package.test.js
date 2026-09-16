import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID,
  normalizeMicroduckFootballArchive,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-football/package.js';
import { createMicroduckFootballArchiveFixture } from './fixtures/microduck-football-archive.fixture.js';

function resolved(value) {
  assert.equal(value.status, 'resolved');
  return value;
}

describe('F311 Microduck football control package identity', () => {
  it('normalizes equivalent evaluation conditions to one unselected package', async () => {
    const source = createMicroduckFootballArchiveFixture();
    const extendedSource = structuredClone(source);
    extendedSource.plan.durationSeconds = 26;
    extendedSource.environment.episode.durationSeconds = 26;
    extendedSource.episodes.push({ id: 'extension-episode' });

    const baseline = resolved(await normalizeMicroduckFootballArchive(source));
    const extended = resolved(await normalizeMicroduckFootballArchive(extendedSource));

    assert.deepEqual(extended.packageRef, baseline.packageRef);
    assert.deepEqual(extended.package, baseline.package);
    assert.equal(baseline.selection, 'unselected');
    assert.equal(baseline.packageRef.assetId, MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID);
    assert.match(baseline.packageRef.ownerStateRef, /^control-package:sha256:[a-f0-9]{64}$/u);

    const serialized = Buffer.from(baseline.packageBytes).toString('utf8');
    assert.doesNotMatch(serialized, /durationSeconds|cases|seed|split|video|episodes|goalAccepted/u);
    assert.equal(baseline.package.controller.kickDurationSeconds, 0.5);
    assert.equal(baseline.package.controller.invocationInputs.kickFoot, 'runtime_left_or_right');
    assert.equal(baseline.package.controller.observation.ballStateSource, 'mujoco_ground_truth');
  });

  it('excludes evaluation conditions but versions deployable model, controller, scene, kick, and ABI changes', async () => {
    const source = createMicroduckFootballArchiveFixture();
    const baseline = resolved(await normalizeMicroduckFootballArchive(source));

    const evaluationOnly = structuredClone(source);
    evaluationOnly.plan.durationSeconds = 99;
    evaluationOnly.plan.triggerSeconds = 3;
    evaluationOnly.plan.targetDirectionXY = [0, 1];
    evaluationOnly.plan.cases = [{ id: 'right-far', behavior: 'kick_right', ballXY: [0.3, -0.2], kickSeconds: 0.5 }];
    evaluationOnly.plan.seedSet = { ref: 'seed-set:sha256:not-a-package-input' };
    evaluationOnly.episodes = [];
    assert.deepEqual(resolved(await normalizeMicroduckFootballArchive(evaluationOnly)).packageRef, baseline.packageRef);

    const mutations = [
      (value) => {
        const digest = 'e'.repeat(64);
        value.plan.modelFiles['alpha_stand.onnx'] = digest;
        value.models['alpha_stand.onnx'].sha256 = digest;
      },
      (value) => {
        value.codeFiles['football/arc_controller.py'] = 'f'.repeat(64);
      },
      (value) => {
        const digest = 'e'.repeat(64);
        value.plan.sceneFiles['scene_ball.xml'] = digest;
        value.environment.source.sceneSha256 = digest;
      },
      (value) => {
        for (const item of value.plan.cases) item.kickSeconds = 0.75;
      },
      (value) => {
        value.runtimeDependencies.mujoco = '3.11.0';
        value.environment.runtimeDependencies.mujoco = '3.11.0';
      },
      (value) => {
        value.plan.approachController.arc.radiusM = 0.25;
      },
    ];

    for (const mutate of mutations) {
      const changed = structuredClone(source);
      mutate(changed);
      assert.notDeepEqual(resolved(await normalizeMicroduckFootballArchive(changed)).packageRef, baseline.packageRef);
    }
  });

  it('fails closed on inconsistent evidence or mixed kick configurations', async () => {
    const source = createMicroduckFootballArchiveFixture();

    const modelDrift = structuredClone(source);
    modelDrift.plan.modelFiles['alpha_stand.onnx'] = 'd'.repeat(64);
    assert.deepEqual(await normalizeMicroduckFootballArchive(modelDrift), {
      status: 'blocked',
      code: 'football_package_evidence_invalid',
    });

    const mixedKick = structuredClone(source);
    mixedKick.plan.cases.push({ kickSeconds: 3 });
    assert.deepEqual(await normalizeMicroduckFootballArchive(mixedKick), {
      status: 'blocked',
      code: 'football_package_configuration_ambiguous',
    });

    const wrongShape = structuredClone(source);
    wrongShape.models['ball_kick_left.onnx'].input = [1, 60];
    assert.deepEqual(await normalizeMicroduckFootballArchive(wrongShape), {
      status: 'blocked',
      code: 'football_package_evidence_invalid',
    });

    const unsafePath = structuredClone(source);
    unsafePath.plan.scenePath = '../../outside.xml';
    unsafePath.environment.source.scenePath = '../../outside.xml';
    assert.deepEqual(await normalizeMicroduckFootballArchive(unsafePath), {
      status: 'blocked',
      code: 'football_package_evidence_invalid',
    });
  });
});
