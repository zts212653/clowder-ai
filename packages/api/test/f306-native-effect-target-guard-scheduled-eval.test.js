import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const { constrainedGhPullRequestOperation } = await import('../../../scripts/native-effect-repository-classifier.mjs');
const runtimeRoot = '/home/user/cat-cafe-runtime';
const shellClassifierPath = fileURLToPath(
  new URL('../../../scripts/native-effect-shell-classifier.mjs', import.meta.url),
);

function decide(command, cwd = runtimeRoot) {
  return decideNativeHookPayload({
    turn_id: 'turn-scheduled-eval',
    tool_name: 'Bash',
    cwd,
    tool_input: { command },
  });
}

describe('F306 scheduled-eval native guard closure', () => {
  test('keeps the shared shell classifier within the repository hard line cap', () => {
    const lineCount = readFileSync(shellClassifierPath, 'utf8').trimEnd().split(/\r?\n/).length;
    assert.ok(lineCount <= 350, `native-effect-shell-classifier.mjs has ${lineCount} lines`);
  });

  test('allows only constrained observation commands from the passive runtime checkout', () => {
    for (const { command, effect = 'read' } of [
      { command: 'date -u +%Y-%m-%dT%H:%M:%SZ' },
      { command: "rg -n 'providerNativeCoverage' packages/api/src 2>/dev/null" },
      { command: 'stat -f %m .cat-cafe/evidence.sqlite >/dev/null 2>&1' },
      { command: 'stat -f %m .cat-cafe/evidence.sqlite' },
      { command: 'git rev-parse HEAD' },
      { command: `git -C ${runtimeRoot} rev-parse HEAD` },
      { command: 'git rev-list --left-right --count HEAD...origin/main' },
      { command: `git -C ${runtimeRoot} status --short --branch` },
      { command: 'git ls-tree -r --name-only origin/main' },
      { command: 'git ls-remote origin refs/heads/main' },
      { command: 'git ls-remote origin pull/4369/head' },
      { command: 'git merge-base --is-ancestor origin/main a184c713be9d1b1a7db7c22754d3608d9706647c' },
      { command: 'git show origin/main:docs/features/F306-codex-app-capability-parity.md' },
      { command: 'git fetch origin main', effect: 'repository_refresh' },
      { command: `git -C ${runtimeRoot} fetch origin main`, effect: 'repository_refresh' },
      { command: 'git fetch --quiet origin main', effect: 'repository_refresh' },
      {
        command: 'git fetch origin pull/4369/head:refs/remotes/origin/pr/4369',
        effect: 'repository_refresh',
      },
      {
        command: `git -C ${runtimeRoot} fetch --quiet origin refs/pull/4369/head:refs/remotes/origin/pr/4369`,
        effect: 'repository_refresh',
      },
      { command: 'sqlite3 -readonly .cat-cafe/evidence.sqlite "SELECT count(*) FROM recall_events"' },
      {
        command:
          'sqlite3 -readonly .cat-cafe/evidence.sqlite "WITH recent AS (SELECT timestamp FROM recall_events) SELECT count(*) FROM recent"',
      },
      { command: 'curl -fsS --max-time 5 http://127.0.0.1:3012/health' },
      { command: 'curl --fail --silent --head http://localhost:3011/' },
      { command: 'ps -p 123 -o pid=,command=' },
      { command: 'lsof -nP -iTCP:3012 -sTCP:LISTEN' },
      { command: 'test -e /tmp/cat-cafe-pr4368' },
      { command: '[ -e /tmp/cat-cafe-pr4368 ]' },
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, effect, command);
      assert.equal(verdict.target.kind, 'runtime_sanctuary', command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  test('models constrained GitHub pull-request reads against a remote repository target', () => {
    for (const { command, target } of [
      {
        command: 'gh pr view 4368 --repo zts212653/cat-cafe --json number,title,headRefOid,mergeable,mergeStateStatus',
        target: 'github://zts212653/cat-cafe/pull/4368',
      },
      {
        command: 'gh pr checks 4368 --repo zts212653/cat-cafe --required',
        target: 'github://zts212653/cat-cafe/pull/4368',
      },
      {
        command: 'gh pr list --repo zts212653/cat-cafe --state open --limit 30 --json number,headRefOid',
        target: 'github://zts212653/cat-cafe/pulls',
      },
      {
        command: 'gh pr view 4368 --json headRefOid',
        target: 'github://current/pull/4368',
      },
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, 'read', command);
      assert.equal(verdict.target.kind, 'remote_repository', command);
      assert.equal(verdict.target.value, target, command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  test('assigns a remote repository coordinate only to parsed pull-request squash mutations', () => {
    const head = '632998aa1330acef1ee1f69063adb3b24af0ced5';
    for (const { command, target } of [
      {
        command: 'gh pr merge 4368 --squash --delete-branch',
        target: 'github://current/pull/4368',
      },
      {
        command: `gh pr merge 4368 --repo zts212653/cat-cafe --squash --delete-branch --match-head-commit ${head}`,
        target: 'github://zts212653/cat-cafe/pull/4368',
      },
      {
        command: `gh pr merge 4368 --squash --admin --repo zts212653/cat-cafe --match-head-commit ${head}`,
        target: 'github://zts212653/cat-cafe/pull/4368',
      },
      {
        command: `gh pr merge 4368 -R zts212653/cat-cafe -s -d --match-head-commit ${head}`,
        target: 'github://zts212653/cat-cafe/pull/4368',
      },
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, 'remote_mutation', command);
      assert.equal(verdict.target.kind, 'remote_repository', command);
      assert.equal(verdict.target.value, target, command);
      assert.equal(verdict.reasonCode, 'remote_repository_policy_deferred', command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  test('classifies only bounded numeric pull-request close mutations', () => {
    for (const { command, target } of [
      {
        command: 'gh pr close 4404',
        target: 'github://current/pull/4404',
      },
      {
        command: 'gh pr close 4404 --repo zts212653/cat-cafe',
        target: 'github://zts212653/cat-cafe/pull/4404',
      },
      {
        command: 'gh pr close 4404 -R zts212653/cat-cafe',
        target: 'github://zts212653/cat-cafe/pull/4404',
      },
    ]) {
      assert.deepEqual(constrainedGhPullRequestOperation(command), { effect: 'remote_mutation', target }, command);
    }

    for (const command of [
      'gh pr close 0',
      'gh pr close 004404',
      'gh pr close main',
      'gh pr close https://github.com/zts212653/clowder-ai/pull/4404',
      'gh pr close 4404 --comment superseded',
      'gh pr close 4404 -c superseded',
      'gh pr close 4404 --delete-branch',
      'gh pr close 4404 -d',
      'gh pr close 4404 --repo zts212653/cat-cafe --repo zts212653/cat-cafe',
      'gh pr close 4404 --repo zts212653/cat-cafe --unknown',
      'gh pr close 4404 && echo closed',
    ]) {
      assert.equal(constrainedGhPullRequestOperation(command), null, command);
    }
  });

  test('assigns bounded pull-request closes to the remote repository policy layer', () => {
    for (const { command, target } of [
      {
        command: 'gh pr close 4404',
        target: 'github://current/pull/4404',
      },
      {
        command: 'gh pr close 4404 --repo zts212653/cat-cafe',
        target: 'github://zts212653/cat-cafe/pull/4404',
      },
      {
        command: 'gh pr close 4404 -R zts212653/cat-cafe',
        target: 'github://zts212653/cat-cafe/pull/4404',
      },
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, 'remote_mutation', command);
      assert.equal(verdict.target.kind, 'remote_repository', command);
      assert.equal(verdict.target.value, target, command);
      assert.equal(verdict.reasonCode, 'remote_repository_policy_deferred', command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  test('allows bounded detached temporary worktree creation without treating the source checkout as the target', () => {
    const head = 'a184c713be9d1b1a7db7c22754d3608d9706647c';
    for (const { command, effect } of [
      {
        command: `git worktree add /tmp/cat-cafe-pr4369 ${head}`,
        effect: 'write',
      },
      {
        command: `git worktree add --detach /tmp/cat-cafe-pr4369 ${head}`,
        effect: 'write',
      },
      {
        command: `git -C ${runtimeRoot} worktree add --detach /private/tmp/cat-cafe-pr4369 ${head}`,
        effect: 'write',
      },
      {
        command: 'git worktree add --detach /tmp/cat-cafe-pr4369 origin/main',
        effect: 'write',
      },
      {
        command: `git -C ${runtimeRoot} worktree add --detach /private/tmp/cat-cafe-pr4369 origin/main`,
        effect: 'write',
      },
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, effect, command);
      assert.equal(verdict.target.kind, 'ordinary', command);
      assert.match(verdict.target.value, /^\/(?:private\/)?tmp\/cat-cafe-pr4369$/, command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  // Removal needs observed paths, covered by the temporary-ancestor fixture matrix.
  test('leaves unmatched ordinary-target mutations to sandbox and permission policy', () => {
    for (const { command, effect } of [
      { command: 'gh pr merge 4368 --merge', effect: 'unknown' },
      { command: 'gh pr merge 4368', effect: 'unknown' },
      { command: 'gh pr merge 4368 --squash --admin', effect: 'unknown' },
      { command: 'gh pr merge --squash', effect: 'unknown' },
      { command: 'git worktree add /tmp/wt1 origin/main', effect: 'write' },
      {
        command: 'git worktree add --detach /opt/ordinary/wt1 a184c713be9d1b1a7db7c22754d3608d9706647c',
        effect: 'write',
      },
      { command: 'curl -X POST https://example.com/tasks', effect: 'service_mutation' },
      { command: 'sqlite3 db "delete from t"', effect: 'write' },
    ]) {
      const verdict = decide(command, '/tmp/ordinary-repo');
      assert.equal(verdict.effect, effect, command);
      assert.equal(verdict.target.kind, 'ordinary', command);
      assert.equal(verdict.reasonCode, 'ordinary_policy_deferred', command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  // Slice 2b (2026-09-27): this compound used to sit in the fail-closed list below, but its
  // only denying step was `tee /tmp/f306-worktree.log` judged as a write into the runtime cwd.
  // tee writes its operand, not its cwd, and the git step is the admitted exact-SHA /tmp shape
  // -- so, like any compound whose every step is admitted on its own, it is admitted.
  test('admits the admitted worktree shape piped into a /tmp log', () => {
    const command =
      'git worktree add --detach /tmp/cat-cafe-pr4369 a184c713be9d1b1a7db7c22754d3608d9706647c | tee /tmp/f306-worktree.log';
    assert.equal(decide(command).decision, 'allow', command);
  });

  test('keeps unsupported mutations fail-closed when the invocation target is protected', () => {
    for (const command of [
      'date 010100002026',
      'node -e "process.stdout.write(String(Date.now()))"',
      'node /tmp/eval-memory-metrics.mjs',
      'git fetch origin +main:main',
      'git fetch origin +pull/4369/head:refs/remotes/origin/pr/4369',
      'git fetch origin pull/4369/head:refs/heads/main',
      `git -C ${runtimeRoot} reset --hard origin/main`,
      'git fetch --force origin main',
      'git worktree add --force --detach /tmp/cat-cafe-pr4369 a184c713be9d1b1a7db7c22754d3608d9706647c',
      'git worktree add /tmp/cat-cafe-pr4369 origin/main',
      'git worktree add --detach /tmp/cat-cafe-pr4369 main',
      'git worktree add --detach /tmp/cat-cafe-pr4369 origin/feature',
      'git worktree add --detach ../cat-cafe-pr4369 a184c713be9d1b1a7db7c22754d3608d9706647c',
      'git worktree add --detach /tmp/cat-cafe-pr-* a184c713be9d1b1a7db7c22754d3608d9706647c',
      'git worktree add --detach /tmp/nested/cat-cafe-pr4369 a184c713be9d1b1a7db7c22754d3608d9706647c',
      'git worktree add --detach /tmp/. a184c713be9d1b1a7db7c22754d3608d9706647c',
      `git worktree add --detach ${runtimeRoot} a184c713be9d1b1a7db7c22754d3608d9706647c`,
      'gh pr merge 4368 --delete-branch',
      'gh pr merge 4368 --merge --delete-branch',
      'gh pr merge 4368 --rebase --delete-branch',
      'gh pr merge 4368 --squash --auto',
      'gh pr merge 4368 --squash --disable-auto',
      'gh pr merge 4368 --squash --admin',
      'gh pr merge 4368 --squash --body unreviewed',
      'gh pr merge 4368 --squash --match-head-commit deadbeef',
      'gh pr merge main --squash',
      'gh pr merge https://github.com/zts212653/clowder-ai/pull/4368 --squash',
      'gh pr merge 4368 --squash -s',
      'gh pr close 0',
      'gh pr close 004404',
      'gh pr close main',
      'gh pr close https://github.com/zts212653/clowder-ai/pull/4404',
      'gh pr close 4404 --comment superseded',
      'gh pr close 4404 -c superseded',
      'gh pr close 4404 --delete-branch',
      'gh pr close 4404 -d',
      'gh pr close 4404 --repo zts212653/cat-cafe --unknown',
      'gh pr list --limit 0',
      'gh pr list --web',
      '/tmp/gh pr merge 4368 --squash --delete-branch',
      '/tmp/ps -p 123',
      '/tmp/lsof -iTCP:3012',
      '/tmp/test -e /tmp/cat-cafe-pr4368',
      'gh pr comment 4369 --repo zts212653/cat-cafe --body approved',
      'gh api repos/zts212653/cat-cafe/pulls/4369 -X PATCH -f state=closed',
      'gh pr view 4369 --repo zts212653/cat-cafe --web',
      'sqlite3 .cat-cafe/evidence.sqlite "SELECT count(*) FROM recall_events"',
      'sqlite3 -readonly .cat-cafe/evidence.sqlite "DELETE FROM recall_events"',
      "sqlite3 -readonly .cat-cafe/evidence.sqlite \"SELECT writefile('/tmp/leak', 'x')\"",
      'curl -fsS -X POST http://127.0.0.1:3012/api/tasks',
      'curl -fsS --data action=delete http://127.0.0.1:3012/api/tasks',
      'curl -fsS -o /tmp/health.json http://127.0.0.1:3012/health',
      "rg -n 'providerNativeCoverage' packages/api/src > /tmp/f306-search.txt",
      'rg -n \'providerNativeCoverage\' packages/api/src 2>/dev/null && node -e "process.exit(0)"',
      'curl -fsS http://example.com/health',
      'date -u; node -e "process.exit(0)"',
      'stat .cat-cafe/evidence.sqlite & node -e "process.exit(0)"',
      'stat .cat-cafe/evidence.sqlite && curl -X DELETE http://127.0.0.1:3012/api/tasks/1',
    ]) {
      assert.equal(decide(command).decision, 'deny', command);
    }
  });

  // Until 2026-09-27 a compound was re-judged by pairing its strongest effect with any
  // protected word anywhere in the text, so each of these was denied although every step on
  // its own is admitted. Each segment is now judged against its own target, in the
  // directories it can run in (see f306-native-effect-target-guard-segment-location.test.js).
  test('admits a compound whose every step is admitted on its own', () => {
    for (const [command, cwd] of [
      ['git worktree add --detach /tmp/cat-cafe-pr4369 a184c713be9d1b1a7db7c22754d3608d9706647c; echo done'],
      ['gh pr merge 4368 --squash --delete-branch && echo merged'],
      ['gh pr close 4404 && echo closed'],
      ['printf cat-cafe-runtime >/dev/null; printf UNGUARDED > /tmp/f306-protected-sentinel', '/tmp/work'],
    ]) {
      assert.equal(decide(command, cwd).decision, 'allow', command);
    }
  });

  // Git's rule: without `--force`, a `+` refspec or a destination outside refs/remotes/, a
  // fetch only updates FETCH_HEAD and remote-tracking refs.
  test('treats an unforced fetch into remote-tracking refs as a refresh', () => {
    for (const command of [
      'git fetch origin pull/4369/head:refs/remotes/origin/pr/4370',
      'git fetch origin feat/x main',
      'git fetch -q origin main fix/y 2>&1',
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, 'repository_refresh', command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  test('recognizes protected ref rewrites through git repository selectors', () => {
    for (const command of [
      'git -C /tmp/ordinary fetch origin +main:main',
      'git -C /tmp/ordinary push --force origin main',
    ]) {
      const verdict = decide(command, '/tmp/work');
      assert.equal(verdict.effect, 'repository_rewrite', command);
      assert.equal(verdict.target.kind, 'protected_branch', command);
      assert.equal(verdict.decision, 'deny', command);
    }
  });
});
