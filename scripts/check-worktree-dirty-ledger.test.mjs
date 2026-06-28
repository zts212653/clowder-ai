import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectDirtyWorktrees,
  formatLedger,
  gitStatusPorcelain,
  isMainEntrypoint,
  parseWorktreePaths,
  STATUS_CHECK_FAILED_SENTINEL,
} from './check-worktree-dirty-ledger.mjs';

describe('check-worktree-dirty-ledger (LL-082 hard layer)', () => {
  describe('parseWorktreePaths', () => {
    it('extracts worktree paths from `git worktree list --porcelain`', () => {
      const porcelain = [
        'worktree /home/user/cat-cafe',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /home/user/cat-cafe-feat',
        'HEAD def456',
        'branch refs/heads/feat/foo',
        '',
      ].join('\n');
      assert.deepStrictEqual(parseWorktreePaths(porcelain), ['/home/user/cat-cafe', '/home/user/cat-cafe-feat']);
    });

    it('empty input -> []', () => {
      assert.deepStrictEqual(parseWorktreePaths(''), []);
    });

    it('preserves trailing whitespace in worktree path (P2 cloud R2: .trim() would corrupt it)', () => {
      // Regression: a worktree directory name can legitimately end in whitespace
      // (e.g. `git worktree add 'wt/dir '`). Previous `.trim()` corrupted the path,
      // so the later `git -C <path>` would fail silently — producing a false-clean
      // ledger entry (worktree appears tracked but never actually checked).
      const porcelain = ['worktree /home/user/wttrail  ', 'HEAD abc123', ''].join('\n');
      assert.deepStrictEqual(parseWorktreePaths(porcelain), ['/home/user/wttrail  ']);
    });

    it('strips trailing CR from CRLF porcelain but preserves spaces (P2 cloud R2)', () => {
      // CRLF porcelain (rare but possible across platforms): the \r is line-format noise,
      // the path's own trailing spaces are data. Only the \r should go.
      const porcelain = 'worktree /home/user/wt-cr  \r\nHEAD abc\r\n\r\n';
      assert.deepStrictEqual(parseWorktreePaths(porcelain), ['/home/user/wt-cr  ']);
    });
  });

  describe('collectDirtyWorktrees', () => {
    it('flags only dirty worktrees, counts files', () => {
      const paths = ['/wt/main', '/wt/clean', '/wt/dirty'];
      const statusOf = (p) => (p === '/wt/dirty' ? ' M file.ts\n?? new.ts' : '');
      const dirty = collectDirtyWorktrees(paths, '/wt/main', statusOf);
      assert.strictEqual(dirty.length, 1);
      assert.strictEqual(dirty[0].path, '/wt/dirty');
      assert.strictEqual(dirty[0].fileCount, 2);
      assert.strictEqual(dirty[0].isCurrent, false);
    });

    it('marks the current worktree (H4: the sibling-dirty case must still be visible)', () => {
      const dirty = collectDirtyWorktrees(['/wt/cur', '/wt/sibling'], '/wt/cur', (p) =>
        p === '/wt/sibling' ? ' M orphan-fix.ts' : '',
      );
      assert.strictEqual(dirty.length, 1);
      assert.strictEqual(dirty[0].path, '/wt/sibling');
      assert.strictEqual(dirty[0].isCurrent, false);
    });

    it('all clean -> []', () => {
      assert.deepStrictEqual(
        collectDirtyWorktrees(['/wt/a'], '/wt/a', () => ''),
        [],
      );
    });
  });

  describe('formatLedger', () => {
    it('clean -> OK line + dirty=false (warn-only, never blocks)', () => {
      const r = formatLedger([]);
      assert.strictEqual(r.dirty, false);
      assert.match(r.lines[0], /OK/);
    });

    it('dirty -> WARN header + per-worktree line + provenance reminder', () => {
      const r = formatLedger([{ path: '/wt/x', isCurrent: false, fileCount: 3 }]);
      assert.strictEqual(r.dirty, true);
      assert.match(r.lines[0], /WARN/);
      assert.ok(r.lines.some((l) => l.includes('/wt/x') && l.includes('3 file')));
      assert.ok(r.lines.some((l) => /PR.*task.*comment|commit.*stash.*discard/i.test(l)));
    });
  });

  describe('gitStatusPorcelain (P2 cloud review: no shell injection)', () => {
    it('passes the worktree path as a discrete exec arg, never interpolated into a shell string', () => {
      const calls = [];
      const fakeExec = (file, args) => {
        calls.push({ file, args });
        return ' M file.ts';
      };
      // A path that WOULD execute if concatenated into a shell command string.
      const evilPath = '/wt/$(touch /tmp/pwned)';
      const out = gitStatusPorcelain(evilPath, fakeExec);
      assert.strictEqual(out, ' M file.ts');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].file, 'git');
      // Path is a verbatim arg — the shell never sees it, so $(...) can't fire.
      assert.deepStrictEqual(calls[0].args, ['-C', evilPath, 'status', '--porcelain']);
    });

    it('on exec failure returns SENTINEL — not "" (warn-only guard never throws; P2 cloud R4)', () => {
      // R4 fix: distinguish "exec failed -> status unknown" from "exec returned
      // empty -> definitely clean". A buffer overflow or missing git used to
      // produce '' (silent-clean); now it produces a sentinel callers must check.
      const throwingExec = () => {
        throw new Error('git failed');
      };
      assert.strictEqual(gitStatusPorcelain('/wt/x', throwingExec), STATUS_CHECK_FAILED_SENTINEL);
    });

    it('passes maxBuffer: 50MB to exec so normal sibling worktrees do not overflow (P2 cloud R4)', () => {
      const calls = [];
      const fakeExec = (file, args, opts) => {
        calls.push({ file, args, opts });
        return '';
      };
      gitStatusPorcelain('/wt/x', fakeExec);
      assert.strictEqual(calls[0].opts.maxBuffer, 50 * 1024 * 1024);
      assert.strictEqual(calls[0].opts.encoding, 'utf8');
    });
  });

  describe('collectDirtyWorktrees + formatLedger (P2 cloud R4: never silent-clean on status check failure)', () => {
    it('sentinel from statusOf -> entry with statusCheckFailed=true (not silently suppressed)', () => {
      const paths = ['/wt/main', '/wt/oversized-sibling', '/wt/clean'];
      const statusOf = (p) => {
        if (p === '/wt/oversized-sibling') return STATUS_CHECK_FAILED_SENTINEL;
        return ''; // clean
      };
      const dirty = collectDirtyWorktrees(paths, '/wt/main', statusOf);
      assert.strictEqual(dirty.length, 1);
      assert.strictEqual(dirty[0].path, '/wt/oversized-sibling');
      assert.strictEqual(dirty[0].statusCheckFailed, true);
      assert.strictEqual(dirty[0].isCurrent, false);
      // Buffer-overflow worktree must NOT be silently dropped from the report.
    });

    it('formatLedger shows explicit "status check FAILED" line for sentinel entries (not "0 file(s)")', () => {
      const r = formatLedger([
        { path: '/wt/oversized', isCurrent: false, statusCheckFailed: true },
        { path: '/wt/normal-dirty', isCurrent: false, fileCount: 3 },
      ]);
      assert.strictEqual(r.dirty, true);
      assert.ok(
        r.lines.some((l) => l.includes('/wt/oversized') && /status check FAILED/i.test(l)),
        'oversized worktree must show explicit FAILED reason, not silent clean',
      );
      assert.ok(
        r.lines.some((l) => l.includes('/wt/normal-dirty') && l.includes('3 file')),
        'normal dirty entry still uses fileCount format',
      );
    });

    it('null/undefined statusOf return treated as clean (defensive — sentinel is the only failure path)', () => {
      // ?? '' ensures null/undefined don't crash; only explicit sentinel triggers failure entry.
      const dirty = collectDirtyWorktrees(['/wt/x'], '/wt/x', () => null);
      assert.deepStrictEqual(dirty, []);
    });
  });

  describe('isMainEntrypoint (P2 cloud R3: URL-escape safe entrypoint guard)', () => {
    it('matches when import.meta.url is URL-encoded but argv[1] is raw (repo path with space)', () => {
      // Regression: previous `import.meta.url === \`file://${argv[1]}\`` failed in
      // /tmp/cat cafe/... because meta.url URL-encodes the space to %20 while
      // argv[1] is raw -> main() never ran, silently disabling the ledger guard.
      const metaUrl = 'file:///tmp/cat%20cafe/scripts/check-worktree-dirty-ledger.mjs';
      const argv1 = '/tmp/cat cafe/scripts/check-worktree-dirty-ledger.mjs';
      assert.strictEqual(isMainEntrypoint(metaUrl, argv1), true);
    });

    it('does not match when argv[1] is a different script (test-import context)', () => {
      const metaUrl = 'file:///home/user/cat-cafe/scripts/check-worktree-dirty-ledger.mjs';
      const argv1 = '/home/user/cat-cafe/scripts/run-checks.mjs';
      assert.strictEqual(isMainEntrypoint(metaUrl, argv1), false);
    });

    it('matches plain ASCII path (no URL-escape needed)', () => {
      const metaUrl = 'file:///home/user/cat-cafe/scripts/check-worktree-dirty-ledger.mjs';
      const argv1 = '/home/user/cat-cafe/scripts/check-worktree-dirty-ledger.mjs';
      assert.strictEqual(isMainEntrypoint(metaUrl, argv1), true);
    });

    it('safe on falsy args -> false (no main() trigger from imports)', () => {
      assert.strictEqual(isMainEntrypoint('', '/wt/x'), false);
      assert.strictEqual(isMainEntrypoint('file:///x', ''), false);
      assert.strictEqual(isMainEntrypoint(undefined, undefined), false);
    });
  });
});
