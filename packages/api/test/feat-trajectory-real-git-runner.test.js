/**
 * F233 Phase C C2b step 2 — RealGitRunner tests
 *
 * Stub `gitCmd` to return canned `git ls-remote / show / log` output; verify
 * parsing + filtering + author extraction without spawning real git.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('RealGitRunner', () => {
  describe('lsRemote — refs parsing + pattern filtering', () => {
    test('parses ls-remote output into branch refs', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const stubOutput = [
        '1fbd96adb88b98e1c915ba4f1356942f6965f0ca\trefs/heads/main',
        '9135d7117abc1234567890abc1234567890abc12\trefs/heads/feat/f233-phase-c-closing',
        'abcdef1234567890abcdef1234567890abcdef12\trefs/heads/fix/f188-phase-k',
        '7b789df9ee0e1f2g3h4i5j6k7l8m9n0o1p2q3r4s\trefs/heads/feat/F200-coverage',
      ].join('\n');
      const stub = async () => stubOutput;
      const runner = new RealGitRunner('/fake/repo', stub);
      const refs = await runner.lsRemote(['fix/*', 'feat/*']);
      assert.strictEqual(refs.length, 3, 'should exclude main, include fix/* + feat/*');
      const branchNames = refs.map((r) => r.branchName).sort();
      assert.deepStrictEqual(branchNames, ['feat/F200-coverage', 'feat/f233-phase-c-closing', 'fix/f188-phase-k']);
      const f188 = refs.find((r) => r.branchName === 'fix/f188-phase-k');
      assert.strictEqual(f188.headCommitSha, 'abcdef1234567890abcdef1234567890abcdef12');
    });

    test('empty patterns → empty result (no useless git call)', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      let called = false;
      const stub = async () => {
        called = true;
        return '';
      };
      const runner = new RealGitRunner('/fake/repo', stub);
      const refs = await runner.lsRemote([]);
      assert.deepStrictEqual(refs, []);
      assert.strictEqual(called, false, 'should short-circuit without calling git');
    });

    test('skips non-heads refs and blank lines', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const stubOutput = [
        '',
        'abcdef\trefs/tags/v1.0', // tag, not branch
        '   ', // blank
        '1234\trefs/heads/feat/x',
        'malformed-line-without-tab',
      ].join('\n');
      const stub = async () => stubOutput;
      const runner = new RealGitRunner('/fake/repo', stub);
      const refs = await runner.lsRemote(['feat/*']);
      assert.deepStrictEqual(refs, [{ branchName: 'feat/x', headCommitSha: '1234' }]);
    });

    test('glob escape: pattern with special regex chars treated literally', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const stubOutput = [
        'aaa\trefs/heads/test.branch',
        'bbb\trefs/heads/testXbranch', // would match if . wasn't escaped
      ].join('\n');
      const stub = async () => stubOutput;
      const runner = new RealGitRunner('/fake/repo', stub);
      const refs = await runner.lsRemote(['test.branch']);
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].branchName, 'test.branch', 'literal dot, not regex any-char');
    });
  });

  describe('getCommitMeta — show + log parsing', () => {
    test('parses commit timestamp (s → ms) + author + recent messages', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const showOutput = '1700000000|noreply@anthropic.com|Claude Opus 4.7\n';
      const logOutput = ['F188: implement fix', 'F188: tests', 'wip'].join('\n');
      const calls = [];
      const stub = async (args) => {
        calls.push(args.join(' '));
        if (args[0] === 'show') return showOutput;
        if (args[0] === 'log') return logOutput;
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      };
      const runner = new RealGitRunner('/fake/repo', stub);
      const meta = await runner.getCommitMeta('abc1234', 'fix/f188-x');
      assert.strictEqual(meta.headCommitAt, 1_700_000_000_000, 's → ms conversion');
      assert.deepStrictEqual(meta.commitMessages, ['F188: implement fix', 'F188: tests', 'wip']);
      assert.strictEqual(calls.length, 2);
      assert.match(calls[0], /show -s --format=/);
      assert.match(calls[1], /log --max-count=20/);
      // 砚砚 re-review P1 regression: git log MUST use SHA (always valid post-fetch)
      // not bare branchName (fails for remote-only branches not checked out locally).
      assert.ok(calls[1].includes('abc1234'), `git log must reference SHA (actual: ${calls[1]})`);
      assert.ok(!calls[1].includes('fix/f188-x'), `git log must not use bare branchName (actual: ${calls[1]})`);
      // Cloud round 1 P1 regression: git log must exclude commits reachable from
      // main (^origin/main) so we get only branch-unique commits, not the entire
      // reachable history walked by `git log <sha>` alone.
      assert.ok(
        calls[1].includes('^origin/main'),
        `git log must exclude main-reachable commits via ^origin/main (actual: ${calls[1]})`,
      );
    });

    test('砚砚 re-review P1 regression: getCommitMeta uses SHA in git log, NOT bare branchName', async () => {
      // Explicit regression: even if branchName looks valid, git log must use SHA
      // because branchName may not exist as local ref after fetch.
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const calls = [];
      const stub = async (args) => {
        calls.push(args);
        if (args[0] === 'show') return '1700000000|opus-47@x|opus-47\n';
        if (args[0] === 'log') return 'msg1\nmsg2\n';
        throw new Error(`unexpected: ${args.join(' ')}`);
      };
      const runner = new RealGitRunner('/fake/repo', stub);
      await runner.getCommitMeta('abc1234567890', 'feat/F215-malformed-toolcall-recovery');
      const logArgs = calls.find((a) => a[0] === 'log');
      assert.ok(logArgs, 'git log should be called');
      assert.ok(logArgs.includes('abc1234567890'), 'revision SHA must be in args');
      assert.ok(!logArgs.includes('feat/F215-malformed-toolcall-recovery'), 'branch name not in args');
    });

    test('cloud round 1 P1 regression: getCommitMeta excludes main-reachable commits via ^origin/main', async () => {
      // Explicit regression: a bare `git log <sha>` walks reachable history including
      // main's commits. We need `^origin/main` to scope to branch-only commits.
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const calls = [];
      const stub = async (args) => {
        calls.push(args);
        if (args[0] === 'show') return '1700000000|opus-47@x|opus-47\n';
        if (args[0] === 'log') return 'msg1\n';
        throw new Error(`unexpected: ${args.join(' ')}`);
      };
      const runner = new RealGitRunner('/fake/repo', stub);
      await runner.getCommitMeta('deadbeefcafe', 'feat/F200-coverage');
      const logArgs = calls.find((a) => a[0] === 'log');
      assert.ok(logArgs, 'git log should be called');
      assert.ok(
        logArgs.includes('^origin/main'),
        `git log must include ^origin/main exclusion (actual: ${JSON.stringify(logArgs)})`,
      );
      // Args order: ['log', '--max-count=20', '--format=%s', <sha>, '^origin/main']
      assert.strictEqual(logArgs[logArgs.length - 1], '^origin/main', '^origin/main must be last arg');
      assert.strictEqual(logArgs[logArgs.length - 2], 'deadbeefcafe', 'SHA must be second-to-last arg');
    });

    test('extracts cat handle from email when matches known pattern', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const showOutput = '1700000000|opus-47@bot.cat-cafe.local|Opus 47\n';
      const stub = async (args) => (args[0] === 'show' ? showOutput : '');
      const runner = new RealGitRunner('/fake/repo', stub);
      const meta = await runner.getCommitMeta('sha', 'b');
      assert.strictEqual(meta.authorIdentity, 'opus-47');
    });

    test('falls back to display name when email has no recognizable handle', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const showOutput = '1700000000|t09020670356@gmail.com|Lysander\n';
      const stub = async (args) => (args[0] === 'show' ? showOutput : '');
      const runner = new RealGitRunner('/fake/repo', stub);
      const meta = await runner.getCommitMeta('sha', 'b');
      assert.strictEqual(meta.authorIdentity, 'Lysander', 'fall back to commit display name');
    });

    test('throws on invalid timestamp (corrupted git output)', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const stub = async () => 'invalid|x@y|z\n';
      const runner = new RealGitRunner('/fake/repo', stub);
      await assert.rejects(() => runner.getCommitMeta('sha', 'b'), /invalid timestamp/);
    });

    test('empty log output (new branch with 0 commits) → empty messages array', async () => {
      const { RealGitRunner } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const stub = async (args) => {
        if (args[0] === 'show') return '1700000000|opus-47@x|opus-47\n';
        return ''; // log empty
      };
      const runner = new RealGitRunner('/fake/repo', stub);
      const meta = await runner.getCommitMeta('sha', 'b');
      assert.deepStrictEqual(meta.commitMessages, []);
    });
  });

  describe('__internal.extractCatHandle — cat handle extraction', () => {
    test('matches known cat patterns from email', async () => {
      const { __internal } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const { extractCatHandle } = __internal;
      assert.strictEqual(extractCatHandle('foo+opus-47@anthropic.com'), 'opus-47');
      assert.strictEqual(extractCatHandle('opus-48@x.y'), 'opus-48');
      assert.strictEqual(extractCatHandle('codex@bot.openai.com'), 'codex');
      assert.strictEqual(extractCatHandle('gpt52@x.y'), 'gpt52');
      assert.strictEqual(extractCatHandle('gemini@x.y'), 'gemini');
      assert.strictEqual(extractCatHandle('gemini35@x.y'), 'gemini35');
    });

    test('null when email matches no known cat handle', async () => {
      const { __internal } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const { extractCatHandle } = __internal;
      assert.strictEqual(extractCatHandle('t09020670356@gmail.com'), null);
      assert.strictEqual(extractCatHandle('user@example.com'), null);
      assert.strictEqual(extractCatHandle(''), null);
    });
  });

  describe('__internal.compileGlobPattern — glob → regex', () => {
    test('* expands to .*; full-match anchored', async () => {
      const { __internal } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const re = __internal.compileGlobPattern('fix/*');
      assert.strictEqual(re.test('fix/anything'), true);
      assert.strictEqual(re.test('fix/'), true);
      assert.strictEqual(re.test('feat/something'), false);
      assert.strictEqual(re.test('prefix-fix/x'), false, 'anchored: must match from start');
    });

    test('escapes regex special chars', async () => {
      const { __internal } = await import('../dist/domains/feat-trajectory/RealGitRunner.js');
      const re = __internal.compileGlobPattern('feat/F.233-x');
      assert.strictEqual(re.test('feat/F.233-x'), true, 'literal dot');
      assert.strictEqual(re.test('feat/F1233-x'), false, '. is escaped, not regex any-char');
    });
  });
});
