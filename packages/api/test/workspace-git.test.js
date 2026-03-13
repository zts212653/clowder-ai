/**
 * F082: Git Health Panel — parser unit tests
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  parseGitLog,
  parseGitStatus,
  parseGitShow,
  parseStaleBranches,
  parseWorktreeHealth,
  parseRuntimeDrift,
  parseDriftCommits,
} = await import('../dist/routes/workspace-git.js');

describe('parseGitLog', () => {
  test('parses NUL-delimited git log output', () => {
    const stdout = [
      'abc123def456abc123def456abc123def456abc12345\x00Alice\x002026-03-07T10:00:00+08:00\x00feat: add thing',
      'def456abc123def456abc123def456abc123def45678\x00Bob\x002026-03-06T09:00:00+08:00\x00fix: bug',
    ].join('\n');
    const commits = parseGitLog(stdout);
    assert.equal(commits.length, 2);
    assert.equal(commits[0].hash, 'abc123def456abc123def456abc123def456abc12345');
    assert.equal(commits[0].short, 'abc123de');
    assert.equal(commits[0].author, 'Alice');
    assert.ok(commits[0].date.startsWith('2026-03-07'));
    assert.equal(commits[0].subject, 'feat: add thing');
    assert.equal(commits[1].author, 'Bob');
  });

  test('returns empty array for empty output', () => {
    assert.deepEqual(parseGitLog(''), []);
    assert.deepEqual(parseGitLog('  \n  '), []);
  });

  test('handles subject containing NUL-like chars gracefully', () => {
    const stdout = `${'a'.repeat(40)}\x00Author\x002026-01-01T00:00:00Z\x00subject with special chars: 你好`;
    const commits = parseGitLog(stdout);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, 'subject with special chars: 你好');
  });
});

describe('parseGitStatus', () => {
  test('categorizes staged/unstaged/untracked', () => {
    const mockOutput = [
      'M  staged-file.ts',
      ' M unstaged-file.ts',
      '?? new-file.ts',
      'A  added-file.ts',
      'MM both-file.ts',
    ].join('\n');
    const result = parseGitStatus(mockOutput);
    assert.equal(result.staged.length, 3, 'M, A, MM are staged');
    assert.equal(result.unstaged.length, 2, 'M (unstaged) and MM');
    assert.equal(result.untracked.length, 1);
    assert.equal(result.untracked[0].path, 'new-file.ts');
  });

  test('returns empty categories for clean repo', () => {
    const result = parseGitStatus('');
    assert.deepEqual(result, { staged: [], unstaged: [], untracked: [] });
  });

  test('handles deleted files', () => {
    const result = parseGitStatus('D  deleted.ts');
    assert.equal(result.staged.length, 1);
    assert.equal(result.staged[0].status, 'D');
  });
});

describe('parseGitShow', () => {
  test('extracts changed files from --stat output', () => {
    const mockStat = [
      ' src/foo.ts | 12 +++---',
      ' src/bar.ts |  3 +++',
      ' 2 files changed, 9 insertions(+), 6 deletions(-)',
    ].join('\n');
    const files = parseGitShow(mockStat);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, 'src/foo.ts');
    assert.equal(files[0].summary, '12 +++---');
    assert.equal(files[1].path, 'src/bar.ts');
  });

  test('returns empty for no stat lines', () => {
    assert.deepEqual(parseGitShow('just a commit message'), []);
    assert.deepEqual(parseGitShow(''), []);
  });
});

// ── Phase 2: Health Dashboard Parsers ────────────────────────────────

describe('parseStaleBranches', () => {
  test('identifies merged branches with author and date', () => {
    const mockOutput = [
      'feat/f079-voting\x002026-03-05T10:00:00+08:00\x00Alice',
      'feat/f080-completion\x002026-03-06T12:00:00+08:00\x00Bob',
      '* main\x002026-03-07T09:00:00+08:00\x00Charlie',
    ].join('\n');
    const result = parseStaleBranches(mockOutput);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'feat/f079-voting');
    assert.equal(result[0].author, 'Alice');
    assert.ok(result[0].lastCommitDate);
  });

  test('returns empty for no merged branches', () => {
    assert.deepEqual(parseStaleBranches(''), []);
  });

  test('excludes main, master, develop from stale list', () => {
    const mockOutput = [
      'main\x002026-03-07\x00X',
      'master\x002026-03-07\x00X',
      'develop\x002026-03-07\x00X',
      'feat/old\x002026-03-01\x00Y',
    ].join('\n');
    const result = parseStaleBranches(mockOutput);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'feat/old');
  });
});

describe('parseWorktreeHealth', () => {
  test('marks worktrees with merged branches as orphan', () => {
    const worktreeListOutput = [
      'worktree /path/to/project',
      'HEAD abc1234567890123456789012345678901234567',
      'branch refs/heads/main',
      '',
      'worktree /path/to/project-f079',
      'HEAD def1234567890123456789012345678901234567',
      'branch refs/heads/feat/f079-voting',
      '',
    ].join('\n');
    const mergedBranches = new Set(['feat/f079-voting']);
    const result = parseWorktreeHealth(worktreeListOutput, mergedBranches);
    assert.equal(result.length, 2);
    assert.equal(result[0].isOrphan, false);
    assert.equal(result[1].isOrphan, true);
    assert.equal(result[1].branch, 'feat/f079-voting');
  });

  test('handles detached HEAD worktrees', () => {
    const output = ['worktree /home/user', 'HEAD abc1234567890123456789012345678901234567', 'detached', ''].join(
      '\n',
    );
    const result = parseWorktreeHealth(output, new Set());
    assert.equal(result.length, 1);
    assert.equal(result[0].branch, '(detached)');
    assert.equal(result[0].isOrphan, false);
  });
});

describe('parseDriftCommits', () => {
  test('parses oneline git log output', () => {
    const logOutput = 'abc1234 feat(F082): add health dashboard\ndef5678 fix(F081): bubble fix\n';
    const commits = parseDriftCommits(logOutput);
    assert.equal(commits.length, 2);
    assert.equal(commits[0].short, 'abc1234');
    assert.equal(commits[0].subject, 'feat(F082): add health dashboard');
    assert.equal(commits[1].short, 'def5678');
  });

  test('returns empty for no output', () => {
    assert.deepEqual(parseDriftCommits(''), []);
  });
});

describe('parseRuntimeDrift', () => {
  test('parses rev-list --left-right count output with commits', () => {
    const commits = [{ short: 'abc', subject: 'feat: x' }];
    const result = parseRuntimeDrift('3\t1\n', 'abc12345', 'def67890', commits);
    assert.equal(result.behindMain, 3);
    assert.equal(result.aheadOfMain, 1);
    assert.equal(result.mainHead, 'abc12345');
    assert.equal(result.runtimeHead, 'def67890');
    assert.equal(result.available, true);
    assert.equal(result.behindCommits.length, 1);
  });

  test('returns zero drift when in sync', () => {
    const result = parseRuntimeDrift('0\t0\n', 'abc', 'abc');
    assert.equal(result.aheadOfMain, 0);
    assert.equal(result.behindMain, 0);
    assert.deepEqual(result.behindCommits, []);
  });
});
