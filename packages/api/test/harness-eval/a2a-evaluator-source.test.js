import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createA2aGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/a2a-generator-adapter.js';
import { validateSourceRefsFormat } from '../../dist/infrastructure/harness-eval/publish-verdict/a2a-source-ref-validation.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Real Git layout: runtime is a linked worktree; the evaluator is a separate,
// declared clone beside the common main repository. No network or service.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-evaluator-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'cat-cafe');
  const evaluator = join(root, 'cat-cafe-eval-a2a-current');
  const runtime = join(root, 'cat-cafe-runtime');
  for (const repo of [main, evaluator]) {
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'fixture');
  }
  git(main, 'worktree', 'add', '--detach', runtime, 'HEAD');
  git(evaluator, 'remote', 'add', 'origin', 'git@github.com:zts212653/clowder-ai.git');
  git(evaluator, 'config', '--local', 'catcafe.lifecycle.owner', 'codex');
  git(evaluator, 'config', '--local', 'catcafe.lifecycle.policy', 'never');
  const liveRoot = join(runtime, 'docs/harness-feedback');
  const sourceRoot = join(evaluator, 'docs/harness-feedback');
  const isolatedRoot = join(root, 'publisher/docs/harness-feedback');
  const registry = setupHarnessFeedback();
  t.after(() => rmSync(registry, { recursive: true, force: true }));
  cpSync(registry, isolatedRoot, { recursive: true });
  for (const feedback of [sourceRoot, liveRoot]) {
    mkdirSync(join(feedback, 'snapshots'), { recursive: true });
    mkdirSync(join(feedback, 'attributions'), { recursive: true });
  }
  const snapshot = `---
feature_id: F167
generated_at: "2026-06-05T10:00:00.000Z"
---
window:
  start_ms: 1780632000000
  end_ms: 1780718400000
  duration_hours: 24
counter_window:
  start_ms: 1780707600000
  end_ms: 1780718400000
  duration_hours: 3
components:
  - id: C1
    name: routing
    confidence: medium
    activation_counts: { c1.route_seen: 12 }
    friction_counts: {}
`;
  const attribution = `---
feature_id: F167
eval_snapshot_id: eval-F167-2026-06-05
generated_at: "2026-06-05T10:01:00.000Z"
---
finding_count: 0
findings: []
no_finding_record:
  reason: no signals above threshold
  evidence: bounded fixture counters are clean
`;
  const refs = {
    snapshotName: '2026-06-05-F167-eval.yaml',
    attributionName: '2026-06-05-F167-attribution.yaml',
    source: {
      kind: 'designated-a2a-evaluator',
      checkoutHeadSha: git(evaluator, 'rev-parse', 'HEAD'),
      snapshotSha256: hash(snapshot),
      attributionSha256: hash(attribution),
    },
  };
  const snapshotPath = join(sourceRoot, 'snapshots', refs.snapshotName);
  const attributionPath = join(sourceRoot, 'attributions', refs.attributionName);
  writeFileSync(snapshotPath, snapshot);
  writeFileSync(attributionPath, attribution);
  const baseline = join(sourceRoot, 'snapshots', '2026-06-04-F167-eval.yaml');
  writeFileSync(baseline, 'baseline stays intact');
  const packet = buildPacket({ id: '2026-06-05-a2a-isolated-source', verdict: 'keep_observe' });
  return {
    main,
    evaluator,
    sourceRoot,
    liveRoot,
    isolatedRoot,
    refs,
    snapshot,
    attribution,
    snapshotPath,
    attributionPath,
    baseline,
    publish: (selected = refs) =>
      createA2aGeneratorAdapter()(packet, selected, {
        liveHarnessFeedbackRoot: liveRoot,
        harnessFeedbackRoot: isolatedRoot,
        publicationTime: '2026-06-05T11:00:00.000Z',
      }),
  };
}

it('publishes hash-pinned evaluator evidence with portable provenance and leaves runtime/main/baseline untouched', async (t) => {
  const f = fixture(t);
  const mainHead = git(f.main, 'rev-parse', 'HEAD');
  const artifact = await f.publish();
  const provenance = JSON.parse(readFileSync(join(artifact.bundleDir, 'provenance.json'), 'utf8'));
  assert.equal(provenance.evidenceSource.kind, 'designated-a2a-evaluator');
  assert.equal(provenance.evidenceSource.checkoutHeadSha, f.refs.source.checkoutHeadSha);
  assert.deepEqual(
    provenance.rawInputs.map((input) => input.sha256),
    [hash(f.snapshot), hash(f.attribution)],
  );
  assert.equal(provenance.evidenceSource.snapshotSha256, hash(f.snapshot));
  assert.equal(provenance.evidenceSource.attributionSha256, hash(f.attribution));
  assert.ok(provenance.rawInputs.every((input) => input.path.startsWith('docs/harness-feedback/')));
  const snapshot = JSON.parse(readFileSync(join(artifact.bundleDir, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.counterWindow.durationHours, 3);
  assert.match(readFileSync(artifact.verdictPath, 'utf8'), /keep_observe/);
  assert.equal(existsSync(join(f.liveRoot, 'snapshots', f.refs.snapshotName)), false);
  assert.equal(git(f.main, 'rev-parse', 'HEAD'), mainHead);
  assert.equal(readFileSync(f.baseline, 'utf8'), 'baseline stays intact');
  assert.equal(readFileSync(f.snapshotPath, 'utf8'), f.snapshot);
  assert.equal(readFileSync(f.attributionPath, 'utf8'), f.attribution);
});

it('keeps basename-only live publication working without requiring an evaluator checkout', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.liveRoot, 'snapshots', f.refs.snapshotName), f.snapshot);
  writeFileSync(join(f.liveRoot, 'attributions', f.refs.attributionName), f.attribution);
  rmSync(f.evaluator, { recursive: true });
  const { source: _source, ...refs } = f.refs;
  const artifact = await f.publish(refs);
  const provenance = JSON.parse(readFileSync(join(artifact.bundleDir, 'provenance.json'), 'utf8'));
  assert.equal(provenance.evidenceSource, undefined);
});

for (const field of ['snapshotSha256', 'attributionSha256']) {
  it(`rejects ${field} mismatch before copying either input`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      f.publish({ ...f.refs, source: { ...f.refs.source, [field]: '0'.repeat(64) } }),
      /invalid_source_ref:.*hash/,
    );
    assert.equal(existsSync(join(f.isolatedRoot, 'snapshots', f.refs.snapshotName)), false);
  });
}

for (const [name, mutate, expected] of [
  [
    'unregistered checkout',
    (f) => git(f.evaluator, 'config', '--local', 'catcafe.lifecycle.owner', 'other'),
    /invalid_source_ref:.*lifecycle/,
  ],
  [
    'wrong retention policy',
    (f) => git(f.evaluator, 'config', '--local', 'catcafe.lifecycle.policy', 'merged'),
    /invalid_source_ref:.*lifecycle/,
  ],
  [
    'foreign repository',
    (f) => git(f.evaluator, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git'),
    /invalid_source_ref:.*origin/,
  ],
  [
    'changed HEAD',
    (f) => {
      f.refs.source.checkoutHeadSha = '0'.repeat(40);
    },
    /invalid_source_ref:.*HEAD/,
  ],
  ['missing selected evidence', (f) => rmSync(f.attributionPath), /evidence_not_found/],
  ['oversized input', (f) => truncateSync(f.snapshotPath, 8 * 1024 * 1024 + 1), /invalid_source_ref:.*8 MiB/],
  [
    'symlinked checkout',
    (f) => {
      renameSync(f.evaluator, `${f.evaluator}-moved`);
      symlinkSync(`${f.evaluator}-moved`, f.evaluator);
    },
    /invalid_source_ref:.*boundary/,
  ],
  [
    'symlinked input',
    (f) => {
      rmSync(f.snapshotPath);
      symlinkSync(f.baseline, f.snapshotPath);
    },
    /invalid_source_ref:.*symlink/,
  ],
  [
    'escaped evidence directory',
    (f) => {
      rmSync(join(f.sourceRoot, 'snapshots'), { recursive: true });
      symlinkSync(f.liveRoot, join(f.sourceRoot, 'snapshots'));
    },
    /invalid_source_ref:.*boundary/,
  ],
]) {
  it(`fails closed for ${name}, even with valid live evidence`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.liveRoot, 'snapshots', f.refs.snapshotName), f.snapshot);
    writeFileSync(join(f.liveRoot, 'attributions', f.refs.attributionName), f.attribution);
    mutate(f);
    await assert.rejects(f.publish(), expected);
    assert.equal(existsSync(join(f.isolatedRoot, 'snapshots', f.refs.snapshotName)), false);
  });
}

it('rejects unknown/path-based sources and incomplete pins at the API validation boundary', () => {
  for (const source of [
    null,
    'path',
    {},
    { kind: 'path', path: '/tmp' },
    { kind: 'designated-a2a-evaluator' },
    {
      kind: 'designated-a2a-evaluator',
      checkoutHeadSha: 'a'.repeat(40),
      snapshotSha256: 'a'.repeat(64),
      attributionSha256: 'b'.repeat(64),
      path: '/tmp',
    },
  ]) {
    assert.equal(
      validateSourceRefsFormat({ snapshotName: 'snap.yaml', attributionName: 'attr.yaml', source }).ok,
      false,
    );
  }
});
