import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyCoCreationDocsLane, collectChangedFiles } from './co-creation-docs-lane.mjs';

describe('classifyCoCreationDocsLane', () => {
  it('routes safe co-created docs to direct push without cloud or full gate', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/architecture/memory-system-overview.md', 'docs/architecture/index.md'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'co_creation_docs');
    assert.equal(result.delivery, 'direct_push');
    assert.equal(result.cloudReview, 'skip');
    assert.equal(result.fullGate, 'skip');
    assert.deepEqual(result.validation, ['node scripts/check-frontmatter.mjs --strict-delta --base origin/main']);
  });

  it('does not turn an ordinary feature doc into governance risk merely because of its directory', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/features/F123-example.md'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'co_creation_docs');
    assert.equal(result.delivery, 'direct_push');
    assert.equal(result.cloudReview, 'skip');
    assert.equal(result.fullGate, 'skip');
    assert.deepEqual(result.governanceFiles, []);
    assert.deepEqual(result.validation, [
      'node scripts/check-frontmatter.mjs --strict-delta --base origin/main',
      'node scripts/check-feature-truth.mjs',
    ]);
  });

  it('keeps BACKLOG registration with safe feature docs on the direct-main lane', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/BACKLOG.md', 'docs/features/F285-stackchan-physical-limb-plugin.md'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'co_creation_docs');
    assert.equal(result.delivery, 'direct_push');
    assert.deepEqual(result.governanceFiles, []);
    assert.deepEqual(result.directMainSharedStateFiles, ['docs/BACKLOG.md']);
    assert.equal(result.reasons.includes('governance_risk'), false);
  });

  it('requires a PR for overlapping work without escalating docs to cloud or full gate', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/discussions/2026-07-10-memory-notes.md'],
      conflict: 'detected',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'co_creation_docs');
    assert.equal(result.delivery, 'pull_request');
    assert.equal(result.cloudReview, 'skip');
    assert.equal(result.fullGate, 'skip');
    assert.ok(result.reasons.includes('conflict_detected'));
  });

  it('requires a PR plus local governance review while keeping context-blind cloud review skipped', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/SOP.md'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'co_creation_docs');
    assert.equal(result.delivery, 'pull_request');
    assert.equal(result.cloudReview, 'skip');
    assert.equal(result.fullGate, 'skip');
    assert.deepEqual(result.governanceFiles, ['docs/SOP.md']);
  });

  it('fails closed to PR when reversibility is unknown', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/architecture/overview.md'],
      conflict: 'none',
      reversibility: 'unknown',
    });

    assert.equal(result.delivery, 'pull_request');
    assert.equal(result.cloudReview, 'skip');
    assert.equal(result.fullGate, 'skip');
    assert.ok(result.reasons.includes('reversibility_unknown'));
  });

  it('keeps code and first-party execution surfaces on regular development SOP', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/architecture/overview.md', 'scripts/check-docs.mjs'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'regular_development');
    assert.equal(result.delivery, 'pull_request');
    assert.equal(result.cloudReview, 'required');
    assert.equal(result.fullGate, 'required');
    assert.deepEqual(result.nonDocFiles, ['scripts/check-docs.mjs']);
  });

  it('normalizes dot segments before deciding whether an explicit path is docs-only', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/../cat-cafe-skills/example/SKILL.md'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.lane, 'regular_development');
    assert.deepEqual(result.changedFiles, ['cat-cafe-skills/example/SKILL.md']);
  });

  it('treats line count as irrelevant to lane selection', () => {
    const result = classifyCoCreationDocsLane({
      changedFiles: ['docs/content/drafts/long-manifesto.md'],
      conflict: 'none',
      reversibility: 'one_commit',
    });

    assert.equal(result.delivery, 'direct_push');
    assert.equal(Object.hasOwn(result, 'lineCount'), false);
  });

  it('rejects an empty change set instead of silently approving direct push', () => {
    assert.throws(
      () => classifyCoCreationDocsLane({ changedFiles: [], conflict: 'none', reversibility: 'one_commit' }),
      /at least one changed file/,
    );
  });
});

describe('collectChangedFiles', () => {
  it('unions tracked and untracked paths and de-duplicates them', () => {
    const commands = [];
    const result = collectChangedFiles({
      repoRoot: '/repo',
      base: 'origin/main',
      runGit(args) {
        commands.push(args.join(' '));
        switch (args.join(' ')) {
          case 'diff --name-only origin/main...HEAD':
            return 'docs/a.md\n';
          case 'diff --name-only':
            return 'docs/b.md\n';
          case 'diff --name-only --cached':
            return 'docs/c.md\n';
          default:
            return 'docs/c.md\ndocs/d.md\n';
        }
      },
    });

    assert.deepEqual(result, ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md']);
    assert.deepEqual(commands, [
      'diff --name-only origin/main...HEAD',
      'diff --name-only',
      'diff --name-only --cached',
      'ls-files --others --exclude-standard',
    ]);
  });
});

describe('co-creation docs CLI', () => {
  it('accepts the literal pnpm argument separator', () => {
    const scriptPath = fileURLToPath(new URL('./co-creation-docs-lane.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--',
        '--files',
        'docs/architecture/overview.md',
        '--conflict',
        'none',
        '--reversibility',
        'one_commit',
        '--require',
        'direct_push',
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).delivery, 'direct_push');
  });

  it('rejects unsupported --require values as invalid input', () => {
    const scriptPath = fileURLToPath(new URL('./co-creation-docs-lane.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--files',
        'docs/architecture/overview.md',
        '--conflict',
        'none',
        '--reversibility',
        'one_commit',
        '--require',
        'co_creation_docs',
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--require must be one of/);
  });
});
