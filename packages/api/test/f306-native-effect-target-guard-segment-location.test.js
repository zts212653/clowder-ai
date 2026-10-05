import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync as removeFixture, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const { segmentLocations } = await import('../../../scripts/native-effect-segment-locations.mjs');
const { splitShellExecutionSegmentsWithSeparators } = await import(
  '../../../scripts/native-effect-shell-classifier.mjs'
);

// 2026-09-27 (thread_muj3x2kabkbmx42l): after every segment was judged, the guard re-paired
// the strongest effect with any protected word anywhere in the text. That produced most of
// the remaining false positives (`cd <main> && git worktree remove /tmp/x` = "deletes main"),
// and it was also the only thing standing in for `cd` tracking. Each segment is now judged
// in the directories it can actually run in; nothing else in the text is its target.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f306-segment-location-')));
after(() => removeFixture(fixtureRoot, { recursive: true, force: true }));
const removable = join(fixtureRoot, 'removable');
mkdirSync(removable);
const station = join(fixtureRoot, 'projects', 'relay-station');
const mainRoot = join(station, 'cat-cafe');
const runtimeRoot = join(station, 'cat-cafe-runtime');
const feature = join(station, 'cat-cafe-feature');
for (const directory of [mainRoot, runtimeRoot, feature, join(runtimeRoot, 'uploads')]) {
  mkdirSync(directory, { recursive: true });
}

const NO_SELF_HOST = { selfHost: () => ({ confidence: 'none' }) };
function decideBoth(command, cwd = mainRoot) {
  const claude = decideNativeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } },
    NO_SELF_HOST,
  );
  const codex = decideNativeHookPayload(
    { turn_id: 'turn-segment-location', tool_name: 'exec_command', cwd, tool_input: { cmd: command } },
    NO_SELF_HOST,
  );
  assert.equal(claude.decision, codex.decision, `providers disagree on: ${command}`);
  return claude;
}

describe('F306 AC-C7: each segment is judged where it runs, not against the whole text', () => {
  test('a protected path named by another segment is not this segment’s target', () => {
    for (const [command, cwd] of [
      [`cd ${mainRoot} && git worktree remove ${removable} && echo removed`, mainRoot],
      [
        `cd /tmp && rm -rf cat-cafe-review-metadata && mkdir cat-cafe-review-metadata && cd ${mainRoot} && git log -1`,
        mainRoot,
      ],
      [`git fetch origin feat/x main && git worktree remove ${removable} && git worktree prune`, mainRoot],
      ['printf cat-cafe-runtime >/dev/null; printf UNGUARDED > /tmp/f306-protected-sentinel', '/tmp'],
      // The shell sits inside the runtime, but the command leaves it before doing anything.
      ['cd /tmp && curl -s http://localhost:3004/health > /tmp/h.json', join(runtimeRoot, 'uploads')],
    ]) {
      const decision = decideBoth(command, cwd);
      assert.equal(decision.decision, 'allow', `${command} → ${decision.reasonCode}`);
    }
  });

  test('a segment runs where the preceding cd leaves it', () => {
    for (const [command, cwd] of [
      [`cd ${runtimeRoot} && git reset --hard && echo x`, mainRoot],
      [`cd ${runtimeRoot}; git reset --hard`, mainRoot],
      [`RT=${runtimeRoot}; cd "$RT" && git checkout -- .`, mainRoot],
      [`cd ${runtimeRoot} && pnpm start`, mainRoot],
      // `||` runs the right side only when cd failed, i.e. still in the runtime.
      [`cd /tmp || git reset --hard`, runtimeRoot],
    ]) {
      const decision = decideBoth(command, cwd);
      assert.equal(decision.decision, 'deny', `${command} (cwd ${cwd}) → ${decision.reasonCode}`);
    }
  });

  // The shared main checkout holds other cats' uncommitted work; `git reset --hard` there
  // is irreversible. It was denied only when the text also named the main path (the removed
  // re-scan); run from inside the checkout it was never denied. The checkout it runs in is
  // its target, wherever it is written from.
  test('a hard reset of the main checkout is denied however it is reached', () => {
    for (const [command, cwd] of [
      ['git reset --hard origin/main', mainRoot],
      ['git reset --hard origin/main', join(mainRoot, 'packages')],
      [`cd ${mainRoot} && git reset --hard origin/main 2>&1 | tail -1`, feature],
      [`cd ${mainRoot}\ngit log --oneline -1\ngit reset --hard origin/main`, feature],
    ]) {
      mkdirSync(join(mainRoot, 'packages'), { recursive: true });
      const decision = decideBoth(command, cwd);
      assert.equal(decision.decision, 'deny', `${command} (cwd ${cwd}) → ${decision.reasonCode}`);
    }
    assert.equal(decideBoth('git reset --hard origin/main', feature).decision, 'allow');
  });

  // A `cd` inside a subshell, a brace group, a branch or a loop may not run, or may not
  // outlive its group: its directory is added to the set, never substituted for the old one.
  // (Found by probing slice 1 before review; codex-astra's scoping counterexamples.)
  test('a grouped, conditional or looped cd still counts where it can take the next segment', () => {
    for (const command of [
      `(cd ${mainRoot} && git reset --hard origin/main)`,
      `if true; then cd ${mainRoot}; fi; git reset --hard`,
      `{ cd ${mainRoot}; git reset --hard; }`,
      `M=${mainRoot}; (cd "$M" && git reset --hard)`,
      `for d in ${mainRoot}; do cd "$d" && git reset --hard; done`,
    ]) {
      const decision = decideBoth(command, feature);
      assert.equal(decision.decision, 'deny', `${command} → ${decision.reasonCode}`);
    }
    // A prefix assignment belongs to its command only, and `git -C` does not move later segments.
    for (const command of [`D=${mainRoot} true; git reset --hard`, `git -C ${mainRoot} status; git reset --hard`]) {
      assert.equal(decideBoth(command, feature).decision, 'allow', command);
    }
  });

  // codex-astra review of #4817 (f71c1e0ea7): follow execution paths exactly — status
  // gating, per-path assignments, subshell scope, and the kernel's symlink-then-`..` order.
  test('directories follow execution paths, per-path bindings, subshell scope and symlinks', () => {
    const start = join(fixtureRoot, 'start');
    const target = join(fixtureRoot, 'target');
    const original = join(fixtureRoot, 'original');
    const destination = join(fixtureRoot, 'destination');
    for (const directory of [start, target, original, join(destination, 'child')]) {
      mkdirSync(directory, { recursive: true });
    }
    symlinkSync(join(destination, 'child'), join(fixtureRoot, 'alias'), 'dir');
    const at = (command, index, env = {}) =>
      segmentLocations(splitShellExecutionSegmentsWithSeparators(command), start, env)[index].sort();

    assert.deepEqual(at(`cd ${target} || echo failed; pwd`, 2), [start, target].sort());
    assert.deepEqual(at(`cd ${target} && pwd; echo ok || echo failed`, 1), [target]);
    assert.deepEqual(at(`false && LOCATION=${target}; cd "$LOCATION" && pwd`, 3, { LOCATION: original }), [original]);
    assert.deepEqual(at(`cd -P ${join(fixtureRoot, 'alias')}/.. && pwd`, 1), [destination]);
    assert.ok(at(`cd ${join(fixtureRoot, 'alias')}/.. && pwd`, 1).includes(destination));
    assert.deepEqual(at(`(cd ${target} && pwd); pwd`, 1), [target]);
    assert.deepEqual(at(`(cd ${target} && pwd); pwd`, 2), [start]);
    assert.deepEqual(at(`! cd ${target} || pwd`, 1), [target]);
    // printf and pwd can fail too; their `||` branch is a real path (codex-astra, 6d53fb50e7).
    assert.deepEqual(at(`printf '%d' nope || cd ${target}; pwd`, 2), [start, target].sort());
    assert.deepEqual(at(`pwd -Z || cd ${target}; pwd`, 2), [start, target].sort());
    // A closer ends its subshell even when the command before it is short-circuited.
    assert.deepEqual(at(`(cd ${target} && false && pwd); pwd`, 3), [start]);
    // Nested subshells restore bindings as well as the directory.
    assert.deepEqual(at(`L=${original}; ( ( L=${target}; cd "$L" ) ); cd "$L" && pwd`, 4), [original]);
    assert.deepEqual(at('cd "$NOT_SET_ANYWHERE" && pwd', 1), [undefined]);
  });

  test('the whole hook decision follows the same paths, for both providers', () => {
    mkdirSync(join(runtimeRoot, 'child'), { recursive: true });
    symlinkSync(join(runtimeRoot, 'child'), join(station, 'rt-alias'), 'dir');
    process.env.F306_SEGMENT_PROBE = runtimeRoot;
    try {
      for (const [command, cwd, expected] of [
        [`(cd ${runtimeRoot} && pwd); git reset --hard`, feature, 'allow'],
        ['cd /tmp || echo failed; git reset --hard', runtimeRoot, 'deny'],
        [`cd ${runtimeRoot} && pwd; echo ok || git status`, mainRoot, 'allow'],
        ['false && F306_SEGMENT_PROBE=/tmp; cd "$F306_SEGMENT_PROBE" && git reset --hard', feature, 'deny'],
        ['true && F306_SEGMENT_PROBE=/tmp; cd "$F306_SEGMENT_PROBE" && git reset --hard', feature, 'allow'],
        [`cd -P ${join(station, 'rt-alias')}/.. && git reset --hard`, feature, 'deny'],
      ]) {
        const decision = decideBoth(command, cwd);
        assert.equal(decision.decision, expected, `${command} (cwd ${cwd}) → ${decision.reasonCode}`);
      }
    } finally {
      delete process.env.F306_SEGMENT_PROBE;
    }
  });

  test('recognised destruction of a protected target stays denied in any position', () => {
    for (const command of [
      `rm -rf ${mainRoot}; echo gone`,
      `cd /tmp && rm -rf ${mainRoot}`,
      `git -C ${mainRoot} reset --hard origin/main && echo done`,
      `echo start && git push --force origin main`,
    ]) {
      const decision = decideBoth(command);
      assert.equal(decision.decision, 'deny', `${command} → ${decision.reasonCode}`);
    }
  });
});
