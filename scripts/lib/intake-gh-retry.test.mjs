import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const LIB = resolve(process.cwd(), 'scripts/lib/intake-gh-retry.sh');

function makeMockGh(workdir, behaviorScript) {
  const binDir = join(workdir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, `#!/bin/bash\n${behaviorScript}\n`);
  chmodSync(ghPath, 0o755);
  return binDir;
}

function runBashTest(workdir, testScript) {
  const driver = join(workdir, 'driver.sh');
  writeFileSync(
    driver,
    `#!/bin/bash
set -u
source "${LIB}"
${testScript}
`,
  );
  chmodSync(driver, 0o755);
  return execFileSync('bash', [driver], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${join(workdir, 'bin')}:${process.env.PATH || ''}`,
    },
  });
}

describe('intake-gh-retry: _gh_with_retry stderr capture', () => {
  const workdirs = [];
  afterEach(() => {
    while (workdirs.length > 0) {
      rmSync(workdirs.pop(), { recursive: true, force: true });
    }
  });

  it('captures stderr after subshell command substitution (V2 fix for cat-cafe#2549 V1 P1)', () => {
    // V1 regression: V1 used a global var to pass stderr back. `$(_gh_with_retry ...)`
    // ran in a subshell; var update never reached the parent's diagnostic branch.
    // V2 uses a tempfile (path env-propagates, content fs-persists across subshells).
    const workdir = mkdtempSync(join(tmpdir(), 'intake-gh-retry-test-'));
    workdirs.push(workdir);
    makeMockGh(workdir, `echo "mock-gh: synthetic transient failure 0xDEAD" >&2\nexit 1`);

    const output = runBashTest(
      workdir,
      `out=$(_gh_with_retry pr diff 999 --repo fake/repo --name-only)
       exit_code=$?
       echo "subshell_exit=$exit_code"
       echo "stderr_after_subshell:"
       _gh_last_stderr || echo "(empty — V1 regression!)"`,
    );

    assert.match(output, /subshell_exit=1/);
    assert.match(
      output,
      /synthetic transient failure 0xDEAD/,
      'stderr must be readable in parent after subshell call (V1 bug regression check)',
    );
    assert.doesNotMatch(output, /\(empty — V1 regression!\)/);
  });

  it('retries 3 attempts then returns stdout on success', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'intake-gh-retry-test-'));
    workdirs.push(workdir);
    // Mock gh: fail first 2 attempts (counter file), succeed on 3rd
    const counterFile = join(workdir, 'counter');
    writeFileSync(counterFile, '0');
    makeMockGh(
      workdir,
      `count=$(cat "${counterFile}")
       count=$((count + 1))
       echo "$count" > "${counterFile}"
       if [ "$count" -lt 3 ]; then
         echo "mock-gh: attempt $count fail" >&2
         exit 1
       fi
       echo "success-payload"
       exit 0`,
    );

    const output = runBashTest(
      workdir,
      `out=$(_gh_with_retry pr diff 999 --repo fake/repo --name-only)
       echo "exit=$?"
       echo "stdout=$out"
       echo "attempts=$(cat "${counterFile}")"`,
    );

    assert.match(output, /exit=0/);
    assert.match(output, /stdout=success-payload/);
    assert.match(output, /attempts=3/);
  });

  it('returns failure after 3 attempts and stderr survives final fail', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'intake-gh-retry-test-'));
    workdirs.push(workdir);
    makeMockGh(workdir, `echo "mock-gh: always-fail err" >&2\nexit 1`);

    const output = runBashTest(
      workdir,
      `_gh_with_retry pr diff 999 --repo fake/repo --name-only
       echo "exit=$?"
       echo "final_stderr:"
       _gh_last_stderr`,
    );

    assert.match(output, /exit=1/);
    assert.match(output, /always-fail err/);
  });
});
