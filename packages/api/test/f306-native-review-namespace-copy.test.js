import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { explicitCopyRoles, isExactNonRecursiveCopy } from '../../../scripts/native-effect-media-classifier.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { secretShellDenial } from '../../../scripts/native-secret-shell.mjs';
import { copyManagedGhCohort, isolateManagedGhProgramFixture } from './helpers/managed-gh-cohort.js';

isolateManagedGhProgramFixture();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-review591-')));
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
mkdirSync(ordinary);
const wrapper = copyManagedGhCohort(runtime);
const ownWrapper = fileURLToPath(new URL('../../../scripts/guarded-bin/gh', import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));

function admission(command) {
  for (const tool_name of ['Bash', 'exec_command']) {
    const verdict = decideNativeHookPayload(
      { tool_name, cwd: ordinary, tool_input: { command, cmd: command } },
      {
        selfHost: () => ({ confidence: 'none' }),
      },
    );
    assert.equal(verdict.decision, 'deny', `${command}: ${JSON.stringify(verdict)}`);
  }
}

test('ambient program loaders still invalidate the ordinary managed fixture', () => {
  const command = `${wrapper} pr comment 1 --repo o/r --body ok`;
  assert.equal(secretShellDenial(command, ordinary), null);
  process.env.NODE_OPTIONS = `--import=${root}/untrusted.mjs`;
  try {
    assert.equal(secretShellDenial(command, ordinary), 'secret_send_requires_managed_command');
    admission(command);
  } finally {
    delete process.env.NODE_OPTIONS;
  }
  assert.equal(secretShellDenial(command, ordinary), null);
});

test('actual sender selection changes are denied and ordinary environment changes pass', () => {
  const bin = join(ordinary, 'external-bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'gh'));
  for (const command of [
    `export PATH=${bin}:$PATH; gh pr comment 1 --body fixture`,
    `CAT_CAFE_REAL_GH_PATH=${bin}/gh ${ownWrapper} pr comment 1 --body fixture`,
    `NODE_OPTIONS=--import=${root}/untrusted.mjs ${ownWrapper} pr comment 1 --body fixture`,
  ])
    admission(command);

  for (const command of [
    `export F306_LOCAL_SCRATCH=${ordinary}; ${ownWrapper} pr comment 1 --body fixture`,
    `GIT_CONFIG_COUNT=0 ${ownWrapper} pr comment 1 --body fixture | tail -1`,
    `env NODE_OPTIONS=--max-old-space-size=4096 ${ownWrapper} pr comment 1 --body fixture`,
    'GH_HOST=example.invalid gh api repos/o/r/pulls/1',
  ])
    assert.equal(secretShellDenial(command, ordinary), null, command);
});

test('ordinary preparation does not invalidate an explicitly selected verified wrapper', () => {
  const body = join(ordinary, 'body.md');
  for (const command of [
    `cat > ${body} <<'EOF'\nPrepared comment.\nEOF\n${wrapper} pr comment 1 --body-file ${body} | tail -1`,
    `python3 -c 'print(1)' && GIT_CONFIG_COUNT=0 ${wrapper} pr view 1`,
    `git push origin HEAD && ${wrapper} pr view 1`,
  ])
    assert.equal(secretShellDenial(command, ordinary), null, command);
});

test('Git hook paths selected from the command environment are checked against the checkout', () => {
  const checkout = fileURLToPath(new URL('../../../', import.meta.url));
  const push = 'git --config-env=core.hooksPath=F306_HOOK_ROOT push origin HEAD';
  assert.equal(secretShellDenial(`F306_HOOK_ROOT=.githooks ${push}`, checkout), null);
  assert.equal(secretShellDenial(`F306_HOOK_ROOT=/dev/null ${push}`, checkout), 'secret_git_hook_bypass_blocked');
});

test('late copy options never become source/destination operands without an explicit separator', () => {
  const destination = join(ordinary, 'export');
  mkdirSync(join(destination, 'dist/nested'), { recursive: true });
  symlinkSync(join(runtime, 'protected'), join(destination, 'dist/nested/asset.js'));
  for (const command of [
    `cp ${runtime}/packages/api/dist -R ${destination}`,
    `cp ${runtime}/avatar.png -s ${destination}`,
    `cp ${runtime}/avatar.png ${destination} -R`,
  ]) {
    assert.equal(explicitCopyRoles(command, ordinary), null, command);
    assert.equal(isExactNonRecursiveCopy(command), false, command);
    admission(command);
  }
  assert.equal(isExactNonRecursiveCopy('cp /tmp/a "$UNSAFE" /tmp/dir'), false);
  assert.equal(isExactNonRecursiveCopy('cp -- /tmp/a -literal /tmp/dir'), true);
  assert.equal(isExactNonRecursiveCopy('cp /tmp/a /tmp/b /tmp/dir'), true);
});

test('complete readonly API loops retain the bare launcher carrier without qualifying explicit wrappers', () => {
  const command = "for id in 1 2; do gh api repos/o/r/actions/jobs/$id --jq '.id'; done";
  for (const tool_name of ['Bash', 'exec_command']) {
    const verdict = decideNativeHookPayload(
      { tool_name, cwd: ordinary, tool_input: { command, cmd: command } },
      {
        selfHost: () => ({ confidence: 'none' }),
      },
    );
    assert.equal(verdict.decision, 'allow', JSON.stringify(verdict));
  }
  admission(`export NODE_OPTIONS=--import=${root}/untrusted.mjs; ${wrapper} api repos/o/r/pulls/1`);
});
