import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

test(
  'reader-recognized removals cannot disappear behind nested shell parameters',
  {
    skip: process.platform === 'win32' ? 'POSIX shell parameter contract' : false,
  },
  () => {
    const base = mkdtempSync('/tmp/f306-remove-parameters-');
    try {
      const checkout = join(base, 'repo');
      const sibling = join(base, 'sibling');
      mkdirSync(checkout);
      mkdirSync(join(checkout, 'child'));
      mkdirSync(sibling);
      const decideBoth = (command) =>
        [
          { tool_name: 'exec_command', cwd: checkout, tool_input: { cmd: command } },
          { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: checkout, tool_input: { command } },
        ].map((payload) => decideNativeHookPayload(payload, { selfHost: () => ({ confidence: 'none' }) }));
      for (const command of [
        'sh -c \'"$1" worktree remove --force .\' _ git',
        'sh -c \'set -- git; "$1" worktree remove --force .\'',
        'sh -c \'cd child; "$@"\' _ git worktree remove --force ..',
        `sh -c 'cd "$1"; git worktree remove --force .' _ ${checkout}/child`,
      ]) {
        for (const verdict of decideBoth(command)) assert.equal(verdict.decision, 'deny', command);
      }
      for (const command of [
        `sh -c 'TARGET=${sibling}; git worktree remove --force "$TARGET"'`,
        'sh -c \'printf "%s" "git worktree remove --force ."\'',
      ]) {
        for (const verdict of decideBoth(command)) assert.equal(verdict.decision, 'allow', command);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
