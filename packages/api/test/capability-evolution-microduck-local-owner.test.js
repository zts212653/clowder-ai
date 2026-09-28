import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMicroduckLocalOwnerBindings,
  registerMicroduckLocalOwnerRuntime,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-local-owner.js';
import {
  createMicroduckRuntimeAdapter,
  MicroduckOwnerRuntimeRegistration,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-owner-runtime.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const baselineRevision = '183f99a40bd7308da3e848de961ed32bb02624a5';
const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:5073988075254b6eac9a0de0e3a27125',
};
const objectRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: 'simulator:walking',
  version: baselineRevision,
};
const scope = {
  programRef,
  cycleRef: {
    ownerFeatureId: 'F311',
    ownerStateRef: `evolution-cycle:${programRef.ownerStateRef}:1`,
  },
  objectRef,
};

function runtime(bindings = createMicroduckLocalOwnerBindings({ repoRoot })) {
  const registration = new MicroduckOwnerRuntimeRegistration();
  registration.connect(bindings);
  return createMicroduckRuntimeAdapter({ registration });
}

describe('F311 local Microduck owner connection', () => {
  it('connects the local owner once through the permanent runtime registration seam', async () => {
    const registration = new MicroduckOwnerRuntimeRegistration();

    assert.equal(registerMicroduckLocalOwnerRuntime({ repoRoot, registration }), true);
    assert.equal(registerMicroduckLocalOwnerRuntime({ repoRoot, registration }), false);

    const observation = await createMicroduckRuntimeAdapter({ registration }).observe(scope);
    assert.equal(observation.status, 'observed');
  });

  it('projects exact baseline observation, honest Tier B media, and owner version evidence', async () => {
    const adapter = runtime();

    const observation = await adapter.observe(scope);
    assert.equal(observation.status, 'observed');
    assert.equal(observation.targetVersionRef.version, baselineRevision);
    assert.equal(observation.baselineVersionRef.assetId, 'walking');
    assert.equal(
      observation.baselineArtifactSha256,
      'e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c',
    );
    assert.deepEqual(
      observation.observationRefs.map((ref) => ref.ownerStateRef),
      [`capture:sha256:${'ede4b724d0e107d06207fe26d7db9394e3691a0cda4efd17b78bcb5bb765a833'}`],
    );

    const manifest = await adapter.manifest({ ...scope, programSequence: 1 });
    assert.equal(manifest.tier, 'B');
    assert.equal(manifest.actionState, 'disabled');
    assert.deepEqual(manifest.blockers, [{ code: 'show_truth_incomplete' }]);
    assert.equal(manifest.sceneMedia.length, 1);
    assert.equal(manifest.sceneMedia[0].source, 'real_capture');
    assert.equal(
      manifest.sceneMedia[0].assetUrl,
      `/api/capability-evolution/programs/${encodeURIComponent(programRef.ownerStateRef)}/adapter-media/0`,
    );

    const media = await adapter.media({ ...scope, programSequence: 1, sceneIndex: 0 });
    assert.equal(media.status, 'resolved');
    assert.equal(media.contentType, 'image/png');
    assert.equal(
      createHash('sha256').update(media.bytes).digest('hex'),
      media.captureRef.ownerStateRef.split(':').at(-1),
    );

    const review = await adapter.versionReview({ programRef, objectRef });
    assert.equal(review.status, 'resolved');
    assert.deepEqual(review.currentVersionRefs, [observation.baselineVersionRef]);
    assert.equal(review.selected.versionRef.version, baselineRevision);
    assert.equal(review.selected.evidence[0].status, 'insufficient');
    assert.match(review.selected.evidence[0].label, /不是步态鲁棒性评估/u);
    assert.match(review.sourceRef.ownerStateRef, /^hf-space:/u);
    assert.match(review.currentProofRef.ownerStateRef, /^hf-space:/u);
    assert.match(review.selected.evidence[0].evidenceRef.ownerStateRef, /^hf-space:/u);
    assert.match(review.selected.evidence[0].proofRef.ownerStateRef, /^capture:sha256:/u);
    assert.equal(review.blockers[0].code, 'baseline_robustness_evaluation_missing');
  });

  it('publishes the real preparation notebook and public control candidates without inventing adoption', async () => {
    const adapter = runtime();
    const preparation = await adapter.preparationReview({ programRef, objectRef });

    assert.equal(preparation.status, 'resolved');
    assert.equal(preparation.updatedAt, '2026-09-07T22:39:35.000Z');
    const materials = preparation.groups.flatMap((group) => group.items);
    assert.ok(materials.some((item) => item.title === '带球场景的可复用起点'));
    assert.ok(materials.some((item) => item.summary.includes('40 次公开运行')));
    const footballArchive = preparation.groups.find((group) => group.title === '足球公开归档（新项目尚未建制）');
    assert.ok(footballArchive);
    assert.deepEqual(
      footballArchive.items.map((item) => item.title),
      [
        '足球环境、采集与录像总览',
        '起步、侧移与转向诊断',
        'v0 · 原地踢球基线',
        'v1 · 走近命令尚未起步',
        'v2 · 直线远球恢复',
        'v3 · 前进弧线路径',
        'v3 时间补充 · 同一控制器的 26 秒条件',
        'v4 · 缩短弧线，右侧踢中、左侧踢空',
      ],
    );
    assert.ok(footballArchive.items.every((item) => item.candidateVersionRef === undefined));
    assert.match(footballArchive.items[0].summary, /44 场景、38,644 条状态、20 段真实录像/u);
    const fixedKickBaseline = footballArchive.items.find((item) => item.title === 'v0 · 原地踢球基线');
    assert.match(fixedKickBaseline.summary, /0\.5 秒与 3 秒球轨迹相同/u);
    assert.doesNotMatch(fixedKickBaseline.summary, /动作轨迹相同/u);
    assert.match(footballArchive.items[6].summary, /不是第五个控制器版本/u);
    const v4 = footballArchive.items[7];
    assert.match(v4.summary, /右偏远球 18\.905 秒触球/u);
    assert.match(v4.summary, /左偏远球 18\.9 秒踢腿但全程无接触/u);
    assert.match(v4.facts.find((fact) => fact.label === '整体判定').value, /双侧改善假设不满足；不采用/u);
    assert.ok(footballArchive.items.every((item) => item.activity?.state === 'completed'));
    const videos = footballArchive.items.flatMap((item) => item.resources).filter((resource) => resource.media);
    assert.equal(videos.length, 14);
    assert.ok(videos.every((resource) => resource.media.contentType === 'video/mp4'));
    assert.ok(videos.every((resource) => resource.media.mediaRef.version.length === 64));
    const v4Videos = v4.resources.filter((resource) => resource.media);
    assert.deepEqual(
      v4Videos.map((resource) => resource.label),
      ['v4 · 左偏远球踢空回放', 'v4 · 右偏远球踢中回放', 'v4 · 左直线回放', 'v4 · 右直线回放'],
    );
    assert.ok(preparation.blockers.some((item) => item.code === 'football_goal_choice_pending'));
    assert.ok(preparation.blockers.some((item) => item.code === 'football_exact_object_unpublished'));
    const candidates = materials.filter((item) => item.candidateVersionRef);
    assert.deepEqual(
      candidates.map((item) => item.candidateVersionRef.assetId),
      ['action-scale-090', 'action-scale-105', 'action-scale-110'],
    );
    assert.match(candidates[2].summary, /公开预选进入 holdout/u);
    assert.match(candidates[2].facts.find((fact) => fact.label === '后续验证').value, /尚未进行/u);

    const catalog = await adapter.versionReview({ programRef, objectRef });
    assert.equal(catalog.status, 'resolved');
    assert.deepEqual(
      catalog.currentVersionRefs.map((ref) => ref.assetKind),
      ['onnx-policy'],
    );
    assert.deepEqual(
      catalog.versions.map((item) => item.versionRef.assetId),
      ['walking', 'action-scale-090', 'action-scale-105', 'action-scale-110'],
    );
    assert.ok(catalog.versions.every((item) => item.parentEdges.length === 0));

    const selectedRef = candidates[2].candidateVersionRef;
    const selected = await adapter.versionReview({ programRef, objectRef, selectedVersionRef: selectedRef });
    assert.equal(selected.status, 'resolved');
    assert.deepEqual(selected.currentVersionRefs, catalog.currentVersionRefs);
    assert.deepEqual(selected.selected.versionRef, selectedRef);
    assert.equal(selected.selected.diff.status, 'unavailable');
    assert.deepEqual(selected.selected.evidence, []);
    assert.deepEqual(selected.selected.uses, []);

    for (const resource of v4Videos) {
      const replay = await adapter.preparationMedia({ programRef, objectRef, mediaRef: resource.media.mediaRef });
      assert.equal(replay.status, 'resolved');
      assert.equal(replay.contentType, 'video/mp4');
      assert.equal(createHash('sha256').update(replay.bytes).digest('hex'), resource.media.mediaRef.version);
    }
    assert.deepEqual(
      await adapter.preparationMedia({
        programRef,
        objectRef,
        mediaRef: {
          ownerFeatureId: 'microduck-owner',
          ownerStateRef: `preparation-media:sha256:${'0'.repeat(64)}`,
          version: '0'.repeat(64),
        },
      }),
      { status: 'blocked', code: 'preparation_media_unavailable' },
    );
  });

  it('reads newly owner-published material from the manifest without code changes and verifies video lazily', async () => {
    let videoReads = 0;
    const bindings = createMicroduckLocalOwnerBindings({
      repoRoot,
      readBytes: async (path) => {
        const bytes = await readFile(path);
        if (path.endsWith('.mp4')) {
          videoReads += 1;
          throw new Error('video bytes unavailable');
        }
        if (!path.endsWith('workspace-publication.json')) return bytes;
        const publication = JSON.parse(bytes.toString('utf8'));
        publication.updatedAt = '2026-09-07T23:00:00.000Z';
        publication.groups[0].items.push({
          materialStateRef: 'repo-material:football:future-public-run',
          title: '后来发布的公开实验',
          summary: '只更新 owner publication，Workspace reader 自动看见。',
          status: 'available',
          activity: {
            state: 'completed',
            updatedAt: '2026-09-07T23:00:00.000Z',
            detail: '公开运行已结束，仍不是正式候选。',
          },
          facts: [],
          resources: [],
        });
        return Buffer.from(JSON.stringify(publication));
      },
    });
    const preparation = await bindings.preparationReview({ programRef, objectRef });
    assert.equal(preparation.status, 'resolved');
    assert.equal(preparation.updatedAt, '2026-09-07T23:00:00.000Z');
    assert.ok(preparation.groups.flatMap((group) => group.items).some((item) => item.title === '后来发布的公开实验'));
    assert.equal(videoReads, 0, 'publication reads do not eagerly read video bytes');

    const mediaRef = preparation.groups
      .flatMap((group) => group.items)
      .flatMap((item) => item.resources)
      .find((resource) => resource.media)?.media.mediaRef;
    assert.ok(mediaRef);
    assert.deepEqual(await bindings.preparationMedia({ programRef, objectRef, mediaRef }), {
      status: 'blocked',
      code: 'preparation_media_unavailable',
    });
    assert.equal(videoReads, 1);
  });

  it('rejects publication path traversal before attempting to read the escaped resource', async () => {
    let escapedReads = 0;
    const guarded = createMicroduckLocalOwnerBindings({
      repoRoot,
      readBytes: async (path) => {
        if (path.endsWith('/pipeline/football')) {
          escapedReads += 1;
          throw new Error('escaped directory read');
        }
        const bytes = await readFile(path);
        if (!path.endsWith('workspace-publication.json')) return bytes;
        const publication = JSON.parse(bytes.toString('utf8'));
        publication.groups[0].items[0].resources[0].path =
          'docs/videos/f311-microduck-roadshow/pipeline/football/evidence/..';
        return Buffer.from(JSON.stringify(publication));
      },
    });
    const preparation = await guarded.preparationReview({ programRef, objectRef });
    assert.equal(preparation.status, 'resolved');
    assert.equal(
      preparation.groups.find((group) => group.title === '足球公开归档（新项目尚未建制）').items[0].status,
      'unavailable',
    );
    assert.equal(escapedReads, 0);
  });

  it('fails the public catalog closed on receipt drift while preserving unrelated baseline truth', async () => {
    const readBytes = async (path) => {
      const bytes = await readFile(path);
      if (!path.endsWith('control-public-evaluation.json')) return bytes;
      const receipt = JSON.parse(bytes.toString('utf8'));
      receipt.receiptSha256 = '0'.repeat(64);
      return Buffer.from(JSON.stringify(receipt));
    };
    const bindings = createMicroduckLocalOwnerBindings({ repoRoot, readBytes });
    const preparation = await bindings.preparationReview({ programRef, objectRef });
    assert.equal(preparation.status, 'unavailable');
    assert.equal(preparation.blockers[0].code, 'artifact_hash_mismatch');

    const review = await bindings.versionReview({ programRef, objectRef });
    assert.equal(review.status, 'resolved');
    assert.deepEqual(
      review.versions.map((item) => item.versionRef.assetId),
      ['walking'],
    );
    assert.ok(review.blockers.some((item) => item.code === 'public_candidate_catalog_unavailable'));
  });

  it('keeps verified public materials readable when only the football screenshot bundle is unavailable', async () => {
    const readBytes = async (path) => {
      if (path.endsWith('football-scene-smoke.md') || path.endsWith('football-scene-ball-29e887ec.png')) {
        throw new Error('football material unavailable');
      }
      return readFile(path);
    };
    const preparation = await createMicroduckLocalOwnerBindings({ repoRoot, readBytes }).preparationReview({
      programRef,
      objectRef,
    });
    assert.equal(preparation.status, 'resolved');
    const materials = preparation.groups.flatMap((group) => group.items);
    assert.equal(materials.find((item) => item.title === '带球场景材料').status, 'unavailable');
    assert.equal(materials.filter((item) => item.candidateVersionRef).length, 3);

    const reportDrift = await createMicroduckLocalOwnerBindings({
      repoRoot,
      readBytes: async (path) => {
        const bytes = await readFile(path);
        return path.endsWith('football-scene-smoke.md')
          ? Buffer.concat([bytes, Buffer.from('\nsource drift\n')])
          : bytes;
      },
    }).preparationReview({ programRef, objectRef });
    assert.equal(reportDrift.status, 'resolved');
    const driftedMaterials = reportDrift.groups.flatMap((group) => group.items);
    assert.equal(driftedMaterials.find((item) => item.title === '带球场景材料').status, 'unavailable');
    assert.equal(driftedMaterials.filter((item) => item.candidateVersionRef).length, 3);
  });
});
