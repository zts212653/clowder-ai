import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

// Use the literal temporary-worktree policy coordinate even on macOS, whose
// os.tmpdir() normally hides this case under /private/var/folders.
test(
  'temporary worktree removal still protects its invoking checkout and ancestors',
  {
    skip: process.platform === 'win32' ? 'POSIX temporary-worktree policy' : false,
  },
  () => {
    const base = realpathSync(mkdtempSync('/tmp/f306-ancestor-'));
    const sibling = realpathSync(mkdtempSync('/tmp/f306-sibling-'));
    const alias = `${sibling}-alias`;
    const childAlias = `${sibling}-child`;
    try {
      const checkout = join(base, 'repo');
      const runtime = join(base, 'cat-cafe-runtime');
      const ordinarySibling = join(base, 'cat-cafe-feature');
      mkdirSync(checkout);
      mkdirSync(join(checkout, 'child'));
      mkdirSync(runtime);
      mkdirSync(ordinarySibling);
      mkdirSync(join(checkout, '-literal'));
      mkdirSync(join(checkout, '>'));
      // A real cwd-relative directory must not be mistaken for Git's worktree suffix lookup.
      mkdirSync(join(checkout, 'repo'));
      mkdirSync(join(checkout, base.split('/').at(-1), 'repo'), { recursive: true });
      symlinkSync(base, alias);
      symlinkSync(join(checkout, 'child'), childAlias);
      const decide = (command, cwd) => {
        const verdicts = [
          { turn_id: 'temporary-ancestor', tool_name: 'exec_command', cwd, tool_input: { cmd: command } },
          { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } },
        ].map((payload) => decideNativeHookPayload(payload, { selfHost: () => ({ confidence: 'none' }) }));
        assert.deepEqual(
          verdicts.map(({ decision, target }) => ({ decision, target })),
          [0, 1].map(() => ({ decision: verdicts[0].decision, target: verdicts[0].target })),
          'both providers must enforce the same temporary-worktree boundary',
        );
        return verdicts[0];
      };
      for (const command of [
        `git worktree remove ${base}`,
        `cd ${checkout} && git worktree remove ${base}`,
        `git -C ${checkout} worktree remove ${base}`,
        `printf ready; git -C ${checkout} worktree remove ${base}`,
        `git worktree remove ${sibling} && git worktree remove ${base}`,
        `git worktree remove ${alias}`,
        `git -C ${childAlias}/.. worktree remove ${base}`,
        'git worktree remove --force .',
        'git worktree remove -f .',
        'git worktree remove -f -f ..',
        'git worktree remove -ff ..',
        'git worktree remove -- .',
        'git worktree remove --force -- .',
        'git worktree remove . --force',
        `git worktree remove --force ${checkout}`,
        `git -C ${checkout} worktree remove --force ${base}`,
        `git worktree remove -f ${base}`,
        `git worktree remove --force ${alias}`,
        `git worktree remove --force ${sibling} && git worktree remove -f ${base}`,
        `printf ready; git -C ${checkout} worktree remove -- ${base}`,
        'git -c color.ui=false worktree remove --force .',
        'git --no-pager worktree remove --force .',
        '/usr/bin/git worktree remove --force .',
        'env git worktree remove --force .',
        `env -C ${childAlias}/.. git worktree remove --force ${base}`,
        `env -C ${childAlias}/.. git -C child worktree remove -f ..`,
        `env -C ${base} env -C repo git -Cchild -c color.ui=false -C.. worktree remove -ff .`,
        `env -C ${base} -C child git worktree remove --force ..`,
        `git -C${base} -c color.ui=false -Crepo worktree remove --force .`,
        `git > ${sibling}/log -C${checkout} worktree 2>/dev/null remove --force .`,
        `sh -c 'cd ${checkout}/child && git worktree remove -f ..'`,
        `env -C ${childAlias}/.. sh -c 'git -C child worktree remove --force ..'`,
        `printf '%s' "$(git -C ${checkout} worktree remove --force .)"`,
      ]) {
        const verdict = decide(command, checkout);
        assert.equal(verdict.decision, 'deny', command);
        assert.equal(verdict.target.kind, 'broad_root', command);
      }
      assert.equal(decide(`git worktree remove ${base}`, base).decision, 'deny');
      // The runtime is only the passive source when removing an unrelated temp worktree.
      for (const cwd of [checkout, runtime]) {
        assert.equal(decide(`git worktree remove ${sibling}`, cwd).decision, 'allow');
        assert.equal(decide(`printf ready; git worktree remove ${sibling}`, cwd).decision, 'allow');
        for (const flags of ['--force', '-f', '-f -f', '-ff', '--', '--force --']) {
          assert.equal(decide(`git worktree remove ${flags} ${sibling}`, cwd).decision, 'allow');
        }
      }
      assert.equal(decide('git worktree remove --force ../cat-cafe-feature', checkout).decision, 'allow');
      assert.equal(decide(`git worktree remove ${sibling} --force`, checkout).decision, 'allow');
      assert.equal(
        decide(`git worktree remove ${sibling} && git worktree remove ${ordinarySibling}`, checkout).decision,
        'allow',
      );
      for (const cwd of [checkout, runtime]) {
        for (const prefix of ['git -c color.ui=false', 'git --no-pager', '/usr/bin/git', 'env git']) {
          assert.equal(decide(`${prefix} worktree remove --force ${sibling}`, cwd).decision, 'allow');
        }
      }
      for (const suffix of ['repo', `${base.split('/').at(-1)}/repo`, '-literal', '>']) {
        assert.equal(decide(`git worktree remove --force -- "${suffix}"`, checkout).decision, 'deny', suffix);
      }
      assert.equal(decide('git worktree remove -- ./-literal', checkout).decision, 'allow');
      assert.equal(decide('git worktree remove -- "./>"', checkout).decision, 'allow');
      assert.equal(decide('git worktree remove -- ./repo', checkout).decision, 'allow');
      assert.equal(
        decide(`env -C ${base} -C child git worktree remove --force ${sibling}`, checkout).decision,
        'allow',
      );
      assert.equal(
        decide(`env -C ${childAlias}/.. git -C child worktree remove --force ${sibling}`, checkout).decision,
        'allow',
      );
      assert.equal(
        decide(`sh -c 'cd ${checkout}/child && git worktree remove --force ${sibling}'`, checkout).decision,
        'allow',
      );
      assert.equal(
        decide(`git > ${sibling}/log worktree remove --force ${ordinarySibling}`, checkout).decision,
        'allow',
      );
      for (const command of [
        'echo "git worktree remove --unknown ."',
        'printf "%s\\n" "git worktree remove --force ."',
        'git grep "git worktree remove --unknown ."',
      ]) {
        assert.equal(decide(command, checkout).decision, 'allow', command);
      }
      for (const operands of [
        `--unknown ${sibling}`,
        `--force=true ${sibling}`,
        `-- ${sibling} ${ordinarySibling}`,
        `-f ${sibling} ${ordinarySibling}`,
        '--force',
      ]) {
        for (const prefix of ['', 'printf ready; ', `git worktree remove ${sibling} && `]) {
          assert.equal(decide(`${prefix}git worktree remove ${operands}`, checkout).decision, 'deny');
        }
      }
      for (const command of [
        `git --git-dir=${checkout}/.git worktree remove --force ${sibling}`,
        `git --work-tree ${checkout} worktree remove --force ${sibling}`,
        `git -C ${base}/missing worktree remove --force ${sibling}`,
        `env -C ${base}/missing git worktree remove --force ${sibling}`,
        `git worktree remove --force ${base}/missing`,
        `git worktree remove --force ${sibling} > ${runtime}/output`,
        `GIT_WORK_TREE=${checkout} sh -c 'git worktree remove --force ${sibling}'`,
        `sh -c 'cd "$UNRESOLVED_DIRECTORY"; git worktree remove --force ${sibling}'`,
      ]) {
        assert.equal(decide(command, checkout).decision, 'deny', command);
      }
    } finally {
      rmSync(childAlias, { force: true });
      rmSync(alias, { force: true });
      rmSync(sibling, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  },
);
