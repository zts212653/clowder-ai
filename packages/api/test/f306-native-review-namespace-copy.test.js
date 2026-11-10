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

test('earlier exported or selection-sensitive bindings do not preserve managed sender identity', () => {
  const prefixes = [
    `export NODE_OPTIONS=--import=${root}/untrusted.mjs`,
    `NODE_OPTIONS=--import=${root}/untrusted.mjs`,
    `PATH=${root}/evil:$PATH`,
    `CAT_CAFE_CREDENTIAL_FILE=/dev/null`,
    `CAT_CAFE_REAL_GH_PATH=${root}/evil/gh`,
    'GH_HOST=example.invalid',
    'HTTPS_PROXY=http://127.0.0.1:9999',
    `HOME=${root}/other-home`,
    `export F306_LOCAL_SCRATCH=${ordinary}`,
    'F306_LOCAL_SCRATCH=x > F306_OUTPUT=changed',
  ];
  for (const prefix of prefixes)
    for (const gh of [wrapper, 'gh']) {
      const command = `${prefix}; ${gh} pr comment 1 --repo o/r --body ok`;
      assert.equal(secretShellDenial(command, ordinary), 'secret_send_requires_managed_command', command);
      admission(command);
    }
  assert.equal(
    secretShellDenial(`F306_LOCAL_SCRATCH=${ordinary}; ${wrapper} pr comment 1 --repo o/r --body ok`, ordinary),
    null,
  );
  for (const tool_name of ['Bash', 'exec_command']) {
    const command = `export F306_LOCAL_SCRATCH=${ordinary}; cp ${runtime}/avatar.png "$F306_LOCAL_SCRATCH/avatar.png"`;
    const result = decideNativeHookPayload(
      { tool_name, cwd: ordinary, tool_input: { command, cmd: command } },
      {
        selfHost: () => ({ confidence: 'none' }),
      },
    );
    assert.equal(result.decision, 'allow', JSON.stringify(result));
  }
});

test('inline environment and delegated carriers cannot bypass proof through the guard own wrapper path', () => {
  for (const gh of [wrapper, ownWrapper, 'gh']) {
    for (const prefix of [
      'CAT_CAFE_CREDENTIAL_FILE=/dev/null',
      'HTTPS_PROXY=http://127.0.0.1:9999',
      'GH_HOST=example.invalid',
      `env CAT_CAFE_REAL_GH_PATH=${root}/unknown`,
      'env -u CAT_CAFE_CREDENTIAL_FILE',
      `NODE_OPTIONS=--import=${root}/untrusted.mjs`,
    ]) {
      const command = `${prefix} ${gh} pr comment 1 --repo o/r --body ok`;
      assert.equal(secretShellDenial(command, ordinary), 'secret_send_requires_managed_command', command);
      admission(command);
    }
  }
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
  admission('GH_HOST=example.invalid gh api repos/o/r/pulls/1');
});
