import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createHarnessHistoryGitSource,
  HARNESS_HISTORY_INDEX_PATH,
} from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-git-source.js';
import { collectRequestReviewHarnessV3UnknownFieldPaths } from '../src/infrastructure/capability-evolution/adapters/request-review/request-review-harness-lineage-v3-schema.js';
import { f314HistoryV3Fixture } from './helpers/f314-history-v3-fixture.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
    'utf8',
  ),
);

test('v3 unknown-field diagnostics bound raw and JSON-Pointer-expanded keys without conflating them', () => {
  const raw = f314HistoryV3Fixture(archive);
  const rawLongKey = 'x'.repeat(1_001);
  const escapedLongKey = '/'.repeat(600);
  Object.assign(raw.story.steps[0], { [rawLongKey]: true, [escapedLongKey]: true });

  const paths = collectRequestReviewHarnessV3UnknownFieldPaths(raw);
  assert.equal(paths.length, 2);
  assert.equal(new Set(paths).size, 2);
  assert.ok(paths.every((path) => path.length <= 1_000));
  assert.ok(paths.every((path) => /\[sha256:[a-f0-9]{64}\]$/.test(path)));
});

test('old runtime acquires a main publication absent from its Git store without moving HEAD; failed fetch cannot use stale main', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f314-source-'));
  const author = join(root, 'author');
  const runtime = join(root, 'runtime');
  const replacement = join(root, 'replacement');
  const remote = join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(author);
    git(author, 'init', '-b', 'main');
    git(author, 'config', 'user.email', 'fixture@example.invalid');
    git(author, 'config', 'user.name', 'F314 fixture');
    mkdirSync(join(author, 'docs/discussions/f314-incident-archive/lineage'), { recursive: true });
    const evidence = 'original evidence\n';
    writeFileSync(join(author, 'docs/discussions/f314-incident-archive/case.md'), evidence);
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'evidence');
    const evidenceCut = git(author, 'rev-parse', 'HEAD');
    const index = structuredClone(archive);
    index.snapshotCommit = evidenceCut;
    index.ownerReviewCommit = evidenceCut;
    index.ownerReviewRef = 'docs/discussions/f314-incident-archive/case.md';
    index.cases = [index.cases[0]];
    index.cases[0].link = 'case.md';
    index.cases[0].sourceTextSha256 = createHash('sha256').update(evidence).digest('hex');
    index.story.cases = [index.story.cases.find((entry: { caseId: string }) => entry.caseId === index.cases[0].caseId)];
    index.story.sources.forEach((source: { path: string }) => {
      source.path = index.ownerReviewRef;
    });
    writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(index));
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'A');
    const a = git(author, 'rev-parse', 'HEAD');
    git(root, 'clone', '--bare', author, remote);
    git(root, 'clone', remote, runtime);
    git(root, 'clone', remote, replacement);
    git(author, 'remote', 'add', 'origin', remote);
    index.story.nodes[0].title = 'B publication with unchanged evidence';
    writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(index));
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'B');
    git(author, 'push', 'origin', 'main');
    const b = git(author, 'rev-parse', 'HEAD');
    assert.throws(() => git(runtime, 'cat-file', '-e', b));
    const source = createHarnessHistoryGitSource({ repoRoot: runtime });
    assert.equal(await source.baseline(), a);
    assert.equal((await source.acquire(b)).story?.nodes[0].title, index.story.nodes[0].title);
    const otherSource = createHarnessHistoryGitSource({ repoRoot: replacement });
    assert.throws(() => git(replacement, 'cat-file', '-e', b));
    assert.equal((await otherSource.read(b)).story?.nodes[0].title, index.story.nodes[0].title);
    assert.equal(git(replacement, 'rev-parse', 'HEAD'), a);
    assert.equal(git(replacement, 'rev-parse', `refs/cat-cafe/harness-history/${b}`), b);
    assert.equal(git(runtime, 'rev-parse', 'HEAD'), a);
    assert.equal(git(runtime, 'status', '--porcelain'), '');
    assert.equal((await source.read(a)).story?.nodes[0].title, archive.story.nodes[0].title);
    git(runtime, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    await assert.rejects(() => source.acquire(b), { code: 'source_unavailable' });
    assert.equal((await source.read(b)).story?.nodes[0].title, index.story.nodes[0].title);
    git(runtime, 'remote', 'set-url', 'origin', remote);
    git(author, 'checkout', '-b', 'unpublished');
    writeFileSync(join(author, 'other.txt'), 'unpublished');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'not main');
    const orphan = git(author, 'rev-parse', 'HEAD');
    git(author, 'push', 'origin', 'unpublished');
    git(runtime, 'fetch', 'origin', 'unpublished');
    await assert.rejects(() => source.acquire(orphan), { code: 'source_not_on_main' });
    git(author, 'checkout', 'main');
    writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), '{malformed JSON');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'malformed history');
    git(author, 'push', 'origin', 'main');
    const malformed = git(author, 'rev-parse', 'HEAD');
    await assert.rejects(() => source.acquire(malformed), { code: 'invalid_history' });

    // Reviewed evidence can be a branch cut that a squash merge never made a main ancestor.
    git(author, 'checkout', '-b', 'reviewed-evidence', evidenceCut);
    const branchEvidence = '<a id="verified-evidence"></a>\nreviewed evidence outside main ancestry\n';
    writeFileSync(join(author, 'docs/discussions/f314-incident-archive/case.md'), branchEvidence);
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'reviewed evidence');
    const branchCut = git(author, 'rev-parse', 'HEAD');
    git(author, 'push', 'origin', 'reviewed-evidence');
    git(author, 'checkout', 'main');
    index.snapshotCommit = branchCut;
    index.ownerReviewCommit = branchCut;
    index.cases[0].sourceTextSha256 = createHash('sha256').update(branchEvidence).digest('hex');
    writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(index));
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'main publication with reviewed branch evidence');
    git(author, 'push', 'origin', 'main');
    const c = git(author, 'rev-parse', 'HEAD');
    const publishedC = structuredClone(index);
    assert.throws(() => git(author, 'merge-base', '--is-ancestor', branchCut, c));
    assert.throws(() => git(runtime, 'cat-file', '-e', branchCut));
    assert.equal((await source.acquire(c)).snapshotCommit, branchCut);
    assert.equal(git(runtime, 'rev-parse', `refs/cat-cafe/harness-history/${branchCut}`), branchCut);
    assert.equal(git(runtime, 'rev-parse', 'HEAD'), a);
    assert.equal(git(runtime, 'status', '--porcelain'), '');

    for (const target of ['story', 'owner'] as const) {
      const indexWithFragment = structuredClone(index);
      if (target === 'story') indexWithFragment.story.sources[0].path += '#missing-evidence';
      else indexWithFragment.ownerReviewRef += '#missing-evidence';
      writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(indexWithFragment));
      git(author, 'add', '.');
      git(author, 'commit', '-m', `${target} source has a broken fragment`);
      git(author, 'push', 'origin', 'main');
      await assert.rejects(() => source.acquire(git(author, 'rev-parse', 'HEAD')), { code: 'invalid_history' });
    }
    index.story.sources[0].path += '#verified-evidence';
    index.ownerReviewRef += '#verified-evidence';
    writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(index));
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'both source fragments exist at the fixed evidence cut');
    git(author, 'push', 'origin', 'main');
    assert.equal((await source.acquire(git(author, 'rev-parse', 'HEAD'))).ownerReviewRef, index.ownerReviewRef);

    for (const target of ['case', 'story', 'owner'] as const) {
      const broken = structuredClone(index);
      if (target === 'case') broken.cases[0].link = 'missing.md';
      else if (target === 'story') broken.story.sources[0].path = 'docs/missing.md';
      else broken.ownerReviewRef = 'docs/missing.md';
      writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(broken));
      git(author, 'add', '.');
      git(author, 'commit', '-m', `${target} references a missing file at an existing commit`);
      git(author, 'push', 'origin', 'main');
      await assert.rejects(() => source.acquire(git(author, 'rev-parse', 'HEAD')), { code: 'invalid_history' });
    }
    rmSync(join(author, HARNESS_HISTORY_INDEX_PATH));
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'main revision has no history index');
    git(author, 'push', 'origin', 'main');
    await assert.rejects(() => source.acquire(git(author, 'rev-parse', 'HEAD')), { code: 'invalid_history' });
    git(author, 'push', 'origin', '--delete', 'reviewed-evidence');
    git(remote, 'reflog', 'expire', '--expire=now', '--all');
    git(remote, 'gc', '--prune=now');
    assert.throws(() => git(remote, 'cat-file', '-e', branchCut));
    assert.throws(() => git(replacement, 'cat-file', '-e', branchCut));
    assert.throws(() => git(replacement, 'cat-file', '-e', c));
    assert.deepEqual(await otherSource.read(c), publishedC);
    assert.equal(git(replacement, 'rev-parse', 'HEAD'), a);
    await assert.rejects(() => otherSource.acquire(c), { code: 'source_unavailable' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3 Git source strips extensions and reports their exact publication paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f314-v3-source-'));
  const author = join(root, 'author');
  const runtime = join(root, 'runtime');
  const remote = join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(author);
    git(author, 'init', '-b', 'main');
    git(author, 'config', 'user.email', 'fixture@example.invalid');
    git(author, 'config', 'user.name', 'F314 v3 fixture');
    mkdirSync(join(author, 'docs/discussions/f314-incident-archive/lineage'), { recursive: true });
    const evidence = 'v3 evidence\n';
    const evidencePath = 'docs/discussions/f314-incident-archive/case.md';
    writeFileSync(join(author, evidencePath), evidence);
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'evidence');
    const evidenceCut = git(author, 'rev-parse', 'HEAD');

    const index = f314HistoryV3Fixture(archive);
    index.snapshotCommit = evidenceCut;
    index.ownerReviewCommit = evidenceCut;
    index.ownerReviewRef = evidencePath;
    index.cases = [index.cases[0]];
    index.cases[0].link = 'case.md';
    index.cases[0].sourceTextSha256 = createHash('sha256').update(evidence).digest('hex');
    index.story.sources[0].path = evidencePath;
    index.story.steps = [index.story.steps[0]];
    index.story.cases = [index.story.cases[0]];
    const cited = archive.cases.find((entry: { citedMemberCommits: unknown[] }) => entry.citedMemberCommits.length)
      ?.citedMemberCommits[0];
    assert.ok(cited);
    index.cases[0].citedMemberCommits = [{ ...structuredClone(cited), futureCitationField: true }];
    index.cases[0].occurredWindow = { start: '2026-09-19', end: '2026-09-20', futureWindowField: true };
    Object.assign(index, { futureRootField: true });
    Object.assign(index.releases[0], { futureReleaseField: true });
    Object.assign(index.releases[0].commits[0], { futureCommitField: true });
    Object.assign(index.cases[0], { futureArchiveCaseField: true });
    Object.assign(index.story.sources[0], { futureSourceField: true });
    Object.assign(index.story.steps[0], { futureStepField: ['ignored'] });
    Object.assign(index.story.cases[0], { futureCaseField: 1 });
    writeFileSync(join(author, HARNESS_HISTORY_INDEX_PATH), JSON.stringify(index));
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'v3 publication');
    const publication = git(author, 'rev-parse', 'HEAD');
    git(root, 'clone', '--bare', author, remote);
    git(root, 'clone', remote, runtime);

    const source = createHarnessHistoryGitSource({ repoRoot: runtime });
    const parsed = await source.acquire(publication);
    assert.equal(parsed.schemaVersion, 3);
    assert.equal('futureStepField' in parsed.story.steps[0], false);
    assert.deepEqual(await source.ignoredFieldPaths?.(publication), [
      '/cases/0/citedMemberCommits/0/futureCitationField',
      '/cases/0/futureArchiveCaseField',
      '/cases/0/occurredWindow/futureWindowField',
      '/futureRootField',
      '/releases/0/commits/0/futureCommitField',
      '/releases/0/futureReleaseField',
      '/story/cases/0/futureCaseField',
      '/story/sources/0/futureSourceField',
      '/story/steps/0/futureStepField',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
