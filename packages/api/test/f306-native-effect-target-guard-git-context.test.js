import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync as removeFixture, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const guardCliPath = fileURLToPath(new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url));
const claudeHookPath = fileURLToPath(new URL('../../../.claude/hooks/runtime-sanctuary-guard.sh', import.meta.url));
const publicWithoutClaudeWrapper =
  !existsSync(new URL('../../../sync-manifest.yaml', import.meta.url)) && !existsSync(claudeHookPath);

// The self-host layer depends on which deployment hosts the test process; it is
// asserted in f300-self-host-guard-hook.test.js, not here.
function withoutDeployment() {
  const env = { ...process.env };
  delete env.CAT_CAFE_DEPLOYMENT_ID;
  return env;
}

// `cd` and `git -C` only choose where a Git mutation runs. On 2026-09-23 the guard
// scanned every token of `cd <main> && git worktree remove ../cat-cafe-x` and denied the
// main checkout as the deletion target (broad_root_irreversible), while the same
// removal without the context prefix was allowed.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f306-git-context-')));
after(() => removeFixture(fixtureRoot, { recursive: true, force: true }));
const stationRoot = join(fixtureRoot, 'projects', 'relay-station');
const mainRoot = join(stationRoot, 'cat-cafe');
const featureRoot = join(stationRoot, 'cat-cafe-feature');
const runtimeRoot = join(stationRoot, 'cat-cafe-runtime');
const runtimeAlias = join(stationRoot, 'rt-alias');
const dottedChild = join(fixtureRoot, 'plain', '..odd');
const runtimeSub = join(runtimeRoot, 'sub');
// `other/alias/..` is the runtime to the kernel and to Git, but `other` to a lexical resolve.
const subAlias = join(fixtureRoot, 'other', 'alias');
for (const directory of [mainRoot, featureRoot, runtimeSub, dottedChild, join(fixtureRoot, 'other')]) {
  mkdirSync(directory, { recursive: true });
}
symlinkSync(runtimeRoot, runtimeAlias, 'dir');
symlinkSync(runtimeSub, subAlias, 'dir');

const NO_SELF_HOST = { selfHost: () => ({ confidence: 'none' }) };
const providers = {
  claude: (command, cwd) =>
    decideNativeHookPayload(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } },
      NO_SELF_HOST,
    ),
  codex: (command, cwd) =>
    decideNativeHookPayload(
      { turn_id: 'turn-git-context', tool_name: 'exec_command', cwd, tool_input: { cmd: command } },
      NO_SELF_HOST,
    ),
};

function decideBoth(command, cwd = mainRoot) {
  const claude = providers.claude(command, cwd);
  const codex = providers.codex(command, cwd);
  assert.equal(claude.source.provider, 'claude', command);
  assert.equal(codex.source.provider, 'codex', command);
  assert.deepEqual(
    { decision: codex.decision, reasonCode: codex.reasonCode, effect: codex.effect, target: codex.target },
    { decision: claude.decision, reasonCode: claude.reasonCode, effect: claude.effect, target: claude.target },
    `providers disagree on: ${command}`,
  );
  return claude;
}

describe('F306 native guard: cd / git -C are context, not the mutation target', () => {
  test('removes a sibling worktree named relative to an explicit Git context', () => {
    for (const [command, cwd] of [
      [`cd ${mainRoot} && git worktree remove ../cat-cafe-feature`, mainRoot],
      [`git -C ${mainRoot} worktree remove ../cat-cafe-feature`, mainRoot],
      [`git -C ${mainRoot} worktree remove ../cat-cafe-feature`, fixtureRoot],
      [`cd ${stationRoot} && cd cat-cafe && git worktree remove ${featureRoot}`, fixtureRoot],
    ]) {
      const verdict = decideBoth(command, cwd);
      assert.equal(verdict.decision, 'allow', command);
      assert.equal(verdict.effect, 'repository_rewrite', command);
      assert.equal(verdict.target.kind, 'ordinary', command);
      assert.equal(verdict.target.value, featureRoot, command);
    }
  });

  test('deletes ordinary local branches named in an explicit Git context', () => {
    for (const command of [
      `cd ${mainRoot} && git branch -D fix/plugin-resume-after-listen`,
      `git -C ${mainRoot} branch -D fix/plugin-resume-after-listen`,
      `cd ${mainRoot} && git branch -d fix/a feat/b`,
      `git -C ${mainRoot} branch --delete fix/a`,
    ]) {
      const verdict = decideBoth(command, fixtureRoot);
      assert.equal(verdict.decision, 'allow', command);
      assert.equal(verdict.effect, 'repository_rewrite', command);
      assert.equal(verdict.target.kind, 'ordinary', command);
    }
  });

  test('still denies a removal whose resolved target is the checkout, an ancestor, or the runtime', () => {
    for (const [command, cwd, kind] of [
      [`cd ${mainRoot} && git worktree remove .`, fixtureRoot, 'broad_root'],
      [`git -C ${mainRoot} worktree remove .`, fixtureRoot, 'broad_root'],
      ['git worktree remove ..', mainRoot, 'broad_root'],
      ['git worktree remove ../..', mainRoot, 'broad_root'],
      // A child named `..odd` is inside its parent; a `startsWith('..')` test would miss it.
      ['git worktree remove ..', dottedChild, 'broad_root'],
      [`cd ${mainRoot} && git worktree remove ${fixtureRoot}`, fixtureRoot, 'broad_root'],
      ['git worktree remove ../cat-cafe-runtime', mainRoot, 'runtime_sanctuary'],
      [`cd ${mainRoot} && git worktree remove ../cat-cafe-runtime`, fixtureRoot, 'runtime_sanctuary'],
      ['git worktree remove ../rt-alias', mainRoot, 'runtime_sanctuary'],
      [`cd ${mainRoot} && git worktree remove ../rt-alias`, fixtureRoot, 'runtime_sanctuary'],
    ]) {
      const verdict = decideBoth(command, cwd);
      assert.equal(verdict.decision, 'deny', command);
      assert.equal(verdict.target.kind, kind, command);
    }
  });

  test('keeps protected branches and the runtime checkout closed for branch deletion', () => {
    for (const [command, kind] of [
      [`git -C ${mainRoot} branch -D main`, 'protected_branch'],
      [`cd ${mainRoot} && git branch -D master`, 'protected_branch'],
      [`git -C ${mainRoot} branch -D refs/heads/main`, 'protected_branch'],
      [`cd ${mainRoot} && git branch -d fix/a main`, 'protected_branch'],
      [`git -C ${mainRoot} branch -D runtime/main-sync`, 'protected_branch'],
      [`cd ${runtimeRoot} && git branch -D fix/a`, 'runtime_sanctuary'],
      [`git -C ${runtimeRoot} branch -D fix/a`, 'runtime_sanctuary'],
      [`git -C ${runtimeAlias} branch -D fix/a`, 'runtime_sanctuary'],
      [`cd ${runtimeAlias} && git branch -D fix/a`, 'runtime_sanctuary'],
      [`cd ${runtimeRoot} && git worktree remove ../cat-cafe-feature`, 'runtime_sanctuary'],
    ]) {
      const verdict = decideBoth(command, fixtureRoot);
      assert.equal(verdict.decision, 'deny', command);
      assert.equal(verdict.target.kind, kind, command);
    }
    assert.equal(decideBoth('git branch -D fix/a', runtimeRoot).decision, 'deny');
    assert.equal(decideBoth('git branch -D fix/a', runtimeAlias).decision, 'deny');
  });

  test('resolves a symlink before the `..` that follows it, the way Git and the kernel do', () => {
    // Review of 7d49ad49ab: path.resolve() folded `alias/..` into `other`, and the guard
    // allowed a branch deletion that Git actually ran inside the runtime checkout.
    for (const [command, cwd] of [
      ['git -C other/alias/.. branch -D fix/a', fixtureRoot],
      ['cd other/alias && git -C .. branch -D fix/a', fixtureRoot],
      [`git -C other/alias/.. worktree remove ${featureRoot}`, fixtureRoot],
      [`cd other/alias && git -C .. worktree remove ${featureRoot}`, fixtureRoot],
      [`git worktree remove ${subAlias}/..`, mainRoot],
      [`cd ${mainRoot} && git worktree remove ${subAlias}/..`, fixtureRoot],
      [`git -C ${mainRoot} worktree remove ../../../other/alias/..`, fixtureRoot],
      // Logical `cd` would land in `other`, `cd -P` in the runtime: the guard cannot
      // know which one the shell runs, so it takes the protected reading.
      ['cd other/alias/.. && git branch -D fix/a', fixtureRoot],
      ['cd other/alias/.. && git worktree remove ../projects/relay-station/cat-cafe-feature', fixtureRoot],
    ]) {
      const verdict = decideBoth(command, cwd);
      assert.equal(verdict.decision, 'deny', command);
      assert.equal(verdict.target.kind, 'runtime_sanctuary', command);
    }
  });

  test('judges every execution segment, so a dangerous segment still denies the command', () => {
    for (const [command, cwd] of [
      ['cd / && rm -rf *', fixtureRoot],
      [`cd ${mainRoot} && git worktree remove ../cat-cafe-feature && rm -rf /`, fixtureRoot],
      [`cd ${mainRoot} && git branch -D fix/a; rm -rf ${mainRoot}`, fixtureRoot],
      [`cd ${mainRoot} && git worktree remove ../cat-cafe-feature && git branch -D main`, fixtureRoot],
      [`git -C ${mainRoot} worktree remove ../cat-cafe-feature && git -C ${runtimeRoot} branch -D fix/a`, fixtureRoot],
    ]) {
      assert.equal(decideBoth(command, cwd).decision, 'deny', command);
    }
    const cleanup = decideBoth(
      `cd ${mainRoot} && git worktree remove ../cat-cafe-feature && git branch -D fix/plugin-resume-after-listen`,
      fixtureRoot,
    );
    assert.equal(cleanup.decision, 'allow');
  });

  test('real hook entries enforce their installed provider contract', async (t) => {
    const hooks = {
      claude: (command, cwd) =>
        spawnSync('bash', [claudeHookPath], {
          encoding: 'utf8',
          env: withoutDeployment(),
          input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
        }),
      codex: (command, cwd) =>
        spawnSync(process.execPath, [guardCliPath], {
          encoding: 'utf8',
          env: withoutDeployment(),
          input: JSON.stringify({
            turn_id: 'turn-hook-cli',
            tool_name: 'exec_command',
            cwd,
            tool_input: { cmd: command },
          }),
        }),
    };
    for (const [provider, run] of Object.entries(hooks)) {
      await t.test(
        provider,
        { skip: provider === 'claude' && publicWithoutClaudeWrapper && 'home Claude wrapper is not exported' },
        () => {
          for (const command of [
            `cd ${mainRoot} && git worktree remove ../cat-cafe-feature`,
            `git -C ${mainRoot} branch -D fix/plugin-resume-after-listen`,
            `env git -c color.ui=false -C${mainRoot} worktree remove --force ${featureRoot}`,
          ]) {
            const result = run(command, fixtureRoot);
            assert.equal(result.status, 0, `${provider}: ${result.stderr}`);
            assert.equal(result.stdout.trim(), '', `${provider} must stay silent (allow): ${command}`);
          }
          for (const command of [
            `cd ${mainRoot} && git worktree remove .`,
            `git -C ${mainRoot} branch -D main`,
            `env -C ${subAlias}/.. /usr/bin/git -c color.ui=false worktree remove --force .`,
            `git -C ${mainRoot} > /tmp/f306-hook-unused-output worktree remove -- .`,
          ]) {
            const result = run(command, fixtureRoot);
            assert.equal(result.status, 0, `${provider}: ${result.stderr}`);
            const output = JSON.parse(result.stdout);
            assert.equal(output.hookSpecificOutput.permissionDecision, 'deny', `${provider}: ${command}`);
          }
        },
      );
    }
  });

  test('keeps a protected or wildcard target denied however the context is written', () => {
    for (const command of [
      `cd ${mainRoot} && git worktree remove ../cat-cafe-*`,
      `cd ${mainRoot} && git --git-dir=${runtimeRoot}/.git worktree remove ../cat-cafe-feature`,
      `cd ${mainRoot} && git worktree remove ../cat-cafe-runtime`,
    ]) {
      assert.equal(decideBoth(command, fixtureRoot).decision, 'deny', command);
    }
    // A feature ref selector cannot name main or runtime/main-sync. Its '*' is
    // not a filesystem wildcard that selects the runtime checkout.
    assert.equal(decideBoth(`cd ${mainRoot} && git branch -D 'fix/*'`, fixtureRoot).decision, 'allow');
  });

  // Until 2026-09-27 these were denied only because the whole text mentioned the main
  // checkout. Each segment is now judged in the directories it can run in (bindings
  // expanded, `;`/`||` keeping the old directory too), and removing a sibling worktree or a
  // named branch is not a mutation of the main checkout. Git itself refuses to remove the
  // main working tree.
  test('cleans up siblings from the main checkout however the context is written', () => {
    for (const command of [
      `FIXTURE_ROOT=${fixtureRoot}; cd "$FIXTURE_ROOT/projects/relay-station/cat-cafe" && git worktree remove ../cat-cafe-feature`,
      `cd ${mainRoot} && git worktree remove --force ../cat-cafe-feature`,
      `cd ${mainRoot} || git worktree remove ${featureRoot}`,
      `cd ${mainRoot}; git worktree remove ${featureRoot}`,
      `cd ${mainRoot} && git branch -D $BRANCH`,
    ]) {
      assert.equal(decideBoth(command, fixtureRoot).decision, 'allow', command);
    }
    assert.equal(
      decideBoth(`cd ${mainRoot} && git worktree remove $(echo ../cat-cafe-feature)`, fixtureRoot).decision,
      'deny',
    );
  });
});
