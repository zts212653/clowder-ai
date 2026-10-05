import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync as removeFixture,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { decideNativeEffect, decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const claudeHookPath = fileURLToPath(new URL('../../../.claude/hooks/runtime-sanctuary-guard.sh', import.meta.url));
const publicWithoutClaudeWrapper =
  !existsSync(new URL('../../../sync-manifest.yaml', import.meta.url)) && !existsSync(claudeHookPath);

// 2026-09-26 (thread_muj3x2kabkbmx42l): 59 of 113 recent Claude sessions carried a guard
// denial, and the two largest reasons were "the parser did not recognise the command"
// (`unknown → broad_root`, `unknown → runtime_sanctuary`). A command the parser cannot read
// is not evidence of danger. A deny needs a recognised dangerous effect on a protected
// target, except for You's two literal iron-rule sanctuaries (runtime, Redis 6399),
// which stay closed to unrecognised commands that name them.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f306-unknown-allow-')));
after(() => removeFixture(fixtureRoot, { recursive: true, force: true }));
const stationRoot = join(fixtureRoot, 'projects', 'relay-station');
const mainRoot = join(stationRoot, 'cat-cafe');
const runtimeRoot = join(stationRoot, 'cat-cafe-runtime');
for (const directory of [mainRoot, runtimeRoot]) mkdirSync(directory, { recursive: true });

const NO_SELF_HOST = { selfHost: () => ({ confidence: 'none' }) };
function decideBoth(command, cwd = mainRoot) {
  const claude = decideNativeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } },
    NO_SELF_HOST,
  );
  const codex = decideNativeHookPayload(
    { turn_id: 'turn-unknown-allow', tool_name: 'exec_command', cwd, tool_input: { cmd: command } },
    NO_SELF_HOST,
  );
  assert.equal(claude.decision, codex.decision, `providers disagree on: ${command}`);
  return claude;
}

describe('F306 AC-C7: an unrecognised command is not a dangerous one', () => {
  test('ordinary work that the parser cannot read is allowed', () => {
    for (const command of [
      // Read-only sweep denied as broad_root_irreversible (main checkout named via cd).
      `cd ${mainRoot} && find . -name '*.jsonl' -mtime -7 | head -2000 | xargs grep -ho 'native guard' | sort | uniq -c`,
      // Document body words read as filesystem roots.
      "cat > /tmp/note.md <<'EOF'\nread / write\nEOF",
      "cat > /tmp/note.md <<'EOF'\nHome: ~\nEOF",
      // A `**` pathspec glob selected the runtime literal and denied a read-only search.
      `git grep -ln "guard" -- ':!**/test/**' ':!*.test.*' | head -20`,
      // Unrecognised script run from the main checkout.
      `cd ${mainRoot} && node scripts/some-report.mjs --out /tmp/report.json`,
      // Prose that mentions the runtime sync branch is not a rewrite of it.
      "cat > /tmp/note.md <<'EOF'\nruntime/main-sync is You's\nEOF",
    ]) {
      const decision = decideBoth(command);
      assert.equal(decision.decision, 'allow', `${command} → ${decision.reasonCode}`);
    }
  });

  test('a recognised remote mutation whose repository is not resolved is allowed', () => {
    // 2026-09-22: `gh pr merge … && echo` was denied remote_mutation_target_unresolved.
    assert.equal(decideBoth('gh pr merge 4368 --squash --delete-branch && echo merged').decision, 'allow');
    // From the runtime checkout too: the same merge on its own was already admitted there
    // (#4401); the `&& echo` form was denied only by the whole-text re-scan removed on
    // 2026-09-27. (`--delete-branch` switches the local branch only when the PR head is the
    // checked-out branch, which the runtime's sync branch never is.)
    assert.equal(decideBoth('gh pr merge 4368 --squash --delete-branch && echo merged', runtimeRoot).decision, 'allow');
    const decision = decideNativeEffect({
      effect: 'remote_mutation',
      target: { kind: 'ordinary', value: '<unresolved>' },
      source: { provider: 'codex', tool: 'shell', cwd: mainRoot },
    });
    assert.equal(decision.decision, 'allow');
  });

  test('an unrecognised effect on a non-sanctuary protected target is allowed', () => {
    for (const kind of ['broad_root', 'protected_branch', 'remote_repository']) {
      const decision = decideNativeEffect({
        effect: 'unknown',
        target: { kind, value: 'x' },
        source: { provider: 'codex', tool: 'shell', cwd: mainRoot },
      });
      assert.equal(decision.decision, 'allow', kind);
    }
  });

  test('recognised destruction and the literal iron-rule sanctuaries stay denied', () => {
    for (const [command, cwd] of [
      ['rm -rf /', mainRoot],
      ['rm -rf ~/', mainRoot],
      ['rm -rf ../*', mainRoot],
      [`trash ${mainRoot}`, stationRoot],
      ['git push --force origin main', mainRoot],
      // Unrecognised commands that literally name a sanctuary.
      // (`cd <runtime> && pnpm start` is classified read_only on main today; that gap
      // predates this change and is not claimed here.)
      ['pnpm start', runtimeRoot],
      ['REDIS_URL=redis://localhost:6399 pnpm dev', mainRoot],
    ]) {
      const decision = decideBoth(command, cwd);
      assert.equal(decision.decision, 'deny', `${command} (cwd ${cwd}) → ${decision.reasonCode}`);
    }
  });
});

describe('Claude hook: a broken shared guard falls back instead of locking every cat out', () => {
  // Refusing every Bash/Edit/Write when the shared guard is missing or crashes leaves no
  // Claude cat able to repair it. The legacy literal patterns in the same hook remain.
  function runHook(guardSource, command) {
    const root = mkdtempSync(join(tmpdir(), 'f306-hook-fallback-'));
    try {
      mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
      mkdirSync(join(root, 'scripts'), { recursive: true });
      const hook = join(root, '.claude', 'hooks', 'runtime-sanctuary-guard.sh');
      copyFileSync(claudeHookPath, hook);
      if (guardSource !== undefined)
        writeFileSync(join(root, 'scripts', 'native-effect-target-guard.mjs'), guardSource);
      const env = { ...process.env };
      delete env.CAT_CAFE_DEPLOYMENT_ID;
      const result = spawnSync('bash', [hook], {
        input: JSON.stringify({ tool_name: 'Bash', cwd: '/tmp', tool_input: { command } }),
        encoding: 'utf8',
        env,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
    } finally {
      removeFixture(root, { recursive: true, force: true });
    }
  }

  for (const [label, guardSource] of [
    ['missing', undefined],
    ['crashing', 'process.exit(3);\n'],
  ]) {
    test(
      `${label} shared guard: ordinary work proceeds, legacy sanctuary patterns still deny`,
      { skip: publicWithoutClaudeWrapper && 'home Claude wrapper is not exported' },
      () => {
        assert.equal(runHook(guardSource, 'ls /tmp'), 'allow');
        assert.equal(runHook(guardSource, 'rm -rf /home/user/cat-cafe-runtime'), 'deny');
      },
    );
  }
});
