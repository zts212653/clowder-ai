import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const runtimeRoot = '/home/user/cat-cafe-runtime';

function decide(command, cwd = runtimeRoot) {
  return decideNativeHookPayload({
    turn_id: 'turn-scheduled-eval',
    tool_name: 'Bash',
    cwd,
    tool_input: { command },
  });
}

describe('F306 scheduled-eval native guard closure', () => {
  test('allows only constrained observation commands from the passive runtime checkout', () => {
    for (const { command, effect = 'read' } of [
      { command: 'date -u +%Y-%m-%dT%H:%M:%SZ' },
      { command: "rg -n 'providerNativeCoverage' packages/api/src 2>/dev/null" },
      { command: 'stat -f %m .cat-cafe/evidence.sqlite >/dev/null 2>&1' },
      { command: 'stat -f %m .cat-cafe/evidence.sqlite' },
      { command: 'git rev-parse HEAD' },
      { command: `git -C ${runtimeRoot} rev-parse HEAD` },
      { command: 'git rev-list --left-right --count HEAD...origin/main' },
      { command: 'git ls-remote origin refs/heads/main' },
      { command: 'git show origin/main:docs/features/F306-codex-app-capability-parity.md' },
      { command: 'git fetch origin main', effect: 'repository_refresh' },
      { command: `git -C ${runtimeRoot} fetch origin main`, effect: 'repository_refresh' },
      { command: 'git fetch --quiet origin main', effect: 'repository_refresh' },
      { command: 'sqlite3 -readonly .cat-cafe/evidence.sqlite "SELECT count(*) FROM recall_events"' },
      {
        command:
          'sqlite3 -readonly .cat-cafe/evidence.sqlite "WITH recent AS (SELECT timestamp FROM recall_events) SELECT count(*) FROM recent"',
      },
      { command: 'curl -fsS --max-time 5 http://127.0.0.1:3012/health' },
      { command: 'curl --fail --silent --head http://localhost:3011/' },
    ]) {
      const verdict = decide(command);
      assert.equal(verdict.effect, effect, command);
      assert.equal(verdict.target.kind, 'runtime_sanctuary', command);
      assert.equal(verdict.decision, 'allow', command);
    }
  });

  test('keeps opaque execution, HTTP writes, SQLite writes, and unauthorized ref mutation fail-closed', () => {
    for (const command of [
      'date 010100002026',
      'node -e "process.stdout.write(String(Date.now()))"',
      'node /tmp/eval-memory-metrics.mjs',
      'git fetch origin +main:main',
      `git -C ${runtimeRoot} reset --hard origin/main`,
      'git fetch --force origin main',
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

  test('keeps protected targets attached to compound mutations after segment inspection', () => {
    const verdict = decide(
      'printf cat-cafe-runtime >/dev/null; printf UNGUARDED > /tmp/f306-protected-sentinel',
      '/tmp/work',
    );

    assert.equal(verdict.effect, 'write');
    assert.equal(verdict.target.kind, 'runtime_sanctuary');
    assert.equal(verdict.decision, 'deny');
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
