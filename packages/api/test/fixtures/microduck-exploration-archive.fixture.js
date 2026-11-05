import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { controllerFingerprint } from '../../dist/infrastructure/capability-evolution/adapters/microduck-exploration/archive-reader.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const cases = [
  { id: 'fixture-left-contact', ballXY: [0.3, 0.1], behavior: 'kick_left', kickSeconds: 0.5, approach: true },
  { id: 'fixture-right-farther', ballXY: [0.6, -0.2], behavior: 'kick_right', kickSeconds: 0.5, approach: true },
  { id: 'fixture-standing', ballXY: [0.4, 0], behavior: null, kickSeconds: 0.5 },
];

function captureFor(entry) {
  const noKickContact = entry.id === 'fixture-right-farther';
  return {
    schemaVersion: 1,
    case: entry,
    events: entry.behavior && !noKickContact ? [{ kind: 'kick_trigger', seconds: 1 }] : [],
    contacts: entry.behavior
      ? [
          {
            seconds: noKickContact ? 0.75 : 1.25,
            robotBody: entry.behavior === 'kick_left' ? 'ankle_left' : 'ankle_right',
          },
        ]
      : [],
    samples: [0, 1, 2].map((seconds) => ({
      seconds,
      robotPositionM: [seconds * 0.05, 0, 0.2],
      ballPositionM: [...entry.ballXY, 0.04],
      robotQuaternionWxyz: [1, 0, 0, 0],
    })),
    metrics: { terminalReason: 'completed' },
  };
}

// Six tiny synthetic runs: three catalog groups (one repeated), two unordered
// comparison-only groups, and an overlapping comparison run. No home data copy.
export async function createExplorationArchiveFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f330-exploration-archive-'));
  const root = join(repoRoot, 'docs/videos/f311-microduck-roadshow/pipeline/football');
  const save = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    return { path, sha256: digest(bytes) };
  };
  const runs = [];
  for (const [id, version] of [
    ['fixture-origin', 0],
    ['fixture-turn', 1],
    ['fixture-positions', 2],
    ['fixture-position-repeat', 2],
    ['fixture-compare-a', 3],
    ['fixture-compare-b', 4],
  ]) {
    const directory = `evidence/${id}`;
    const manifest = { schemaVersion: 1, files: {} };
    const saveRun = async (name, bytes) => {
      const ref = await save(`${directory}/${name}`, bytes);
      manifest.files[name] = { bytes: bytes.length, sha256: ref.sha256 };
      return ref;
    };
    const episodes = [];
    const records = [];
    for (const entry of cases) {
      const capture = captureFor(entry);
      const expanded = json(capture);
      const captureName = `${entry.id}.json.gz`;
      const captureRef = await saveRun(captureName, gzipSync(expanded, { mtime: 0 }));
      const uncompressedSha256 = digest(expanded);
      episodes.push({
        capture: captureName,
        case: entry,
        compressedSha256: captureRef.sha256,
        uncompressedSha256,
        metrics: { samples: 3 },
      });
      records.push({
        runId: id,
        versionId: `v${version}`,
        caseId: entry.id,
        captureRef,
        uncompressedSha256,
        videoRef: null,
      });
    }
    const index = {
      schemaVersion: 1,
      kind: 'microduck_football_preparation_probe',
      repositoryHead: 'a'.repeat(40),
      codeFiles: { 'football/football_contract.py': 'b'.repeat(64) },
      runtimeDependencies: { simulator: 'fixture' },
      environment: {
        source: { kind: 'synthetic-contract-fixture' },
        episode: { controlHz: 50, physicsSubstepsPerControl: 4, physicsTimestepSeconds: 0.005 },
      },
      plan: {
        actionScale: 1 + version / 10,
        modelFiles: { 'fixture.onnx': 'c'.repeat(64) },
        observationLayout: 'independent fixture',
        approachAlgorithm: 'direct',
        durationSeconds: 2,
        triggerSeconds: 0.25,
        targetDirectionXY: [1, 0],
        cases,
        newTraining: false,
        goalAccepted: false,
        independentValidation: false,
      },
      episodes,
    };
    const indexRef = await saveRun('index.json', json(index));
    if (id === 'fixture-origin') {
      const videoRef = await saveRun(`${cases[0].id}.mp4`, Buffer.from('synthetic media bytes; hash contract only'));
      const replay = structuredClone(index);
      replay.episodes[0].video = `${cases[0].id}.mp4`;
      records[0].identicalCaptureReplayVideoRef = videoRef;
      records[0].mediaRunRef = await saveRun('media-run.json', json(replay));
    }
    const archiveManifestRef = await save(`${directory}/archive-manifest.json`, json(manifest));
    runs.push({
      id,
      versionId: `v${version}`,
      indexRef,
      archiveManifestRef,
      records,
      fingerprint: controllerFingerprint(index),
    });
  }
  const catalogRuns = runs.slice(0, 4);
  const catalog = {
    schemaVersion: 1,
    scope: 'presentation_and_exploration_preparation_not_owner_truth',
    formalGoalAccepted: false,
    candidateAdopted: false,
    versions: [0, 1, 2].map((version) => ({
      id: `v${version}`,
      parent: version ? `v${version - 1}` : null,
      change: `Independent fixture group ${version}`,
      controllerFingerprintSha256: runs.find((run) => run.versionId === `v${version}`).fingerprint,
      runIds: catalogRuns.filter((run) => run.versionId === `v${version}`).map((run) => run.id),
    })),
    runs: catalogRuns.map(({ id, versionId, indexRef, archiveManifestRef }) => ({
      id,
      versionId,
      indexRef,
      archiveManifestRef,
    })),
    episodes: catalogRuns.flatMap((run) => run.records),
  };
  const comparisonRuns = [runs[2], ...runs.slice(4)];
  const comparison = {
    schemaVersion: 1,
    kind: 'public_short_approach_comparison',
    formalGoalAccepted: false,
    candidateAdopted: false,
    newTraining: false,
    exposure: 'public_development',
    runs: comparisonRuns.map((run) => ({
      version: run.versionId,
      indexRef: run.indexRef,
      controllerFingerprintSha256: run.fingerprint,
    })),
    episodes: comparisonRuns.flatMap((run) =>
      run.records.map(({ runId: _run, versionId, ...record }) => ({ ...record, version: versionId })),
    ),
  };
  await save('readiness/20260909-demo/catalog.json', json(catalog));
  await save('readiness/20260909-short-approach/comparison.json', json(comparison));
  return { repoRoot, cleanup: () => rm(repoRoot, { recursive: true, force: true }) };
}
