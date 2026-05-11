import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assert } from './install-script-test-helpers.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const installScript = readFileSync(resolve(repoRoot, 'scripts', 'install.ps1'), 'utf8');

test('install.ps1 defines Test-LockfileMismatchFailure helper', () => {
  assert.match(
    installScript,
    /function Test-LockfileMismatchFailure\b/,
    'must classify lockfile mismatch errors distinctly from generic install failures',
  );
});

test('Test-LockfileMismatchFailure recognises pnpm 9 lockfile error codes and phrases', () => {
  const fn = installScript.match(/function Test-LockfileMismatchFailure[\s\S]*?\n\}/);
  assert.ok(fn, 'must define Test-LockfileMismatchFailure body');
  const body = fn[0];
  assert.match(body, /ERR_PNPM_OUTDATED_LOCKFILE/, 'must match pnpm outdated lockfile error code');
  assert.match(
    body,
    /ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE/,
    'must match pnpm 8 frozen lockfile drift error code',
  );
  assert.match(body, /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/, 'must match pnpm lockfile config mismatch error code');
  assert.match(body, /frozen-lockfile/i, 'must reference frozen-lockfile error context');
  assert.match(body, /lockfile/i, 'must reference lockfile phrase');
});

test('install.ps1 defines Test-WindowsEpermFailure helper', () => {
  assert.match(
    installScript,
    /function Test-WindowsEpermFailure\b/,
    'must classify Windows EPERM/EBUSY/EACCES errors distinctly',
  );
});

test('Test-WindowsEpermFailure recognises EPERM / EBUSY / EACCES errno codes', () => {
  const fn = installScript.match(/function Test-WindowsEpermFailure[\s\S]*?\n\}/);
  assert.ok(fn, 'must define Test-WindowsEpermFailure body');
  const body = fn[0];
  assert.match(body, /EPERM/, 'must match EPERM errno');
  assert.match(body, /EBUSY/, 'must match EBUSY errno');
  assert.match(body, /EACCES/, 'must match EACCES errno');
});

test('install.ps1 defines Write-WindowsEpermHint to surface actionable fixes', () => {
  assert.match(
    installScript,
    /function Write-WindowsEpermHint\b/,
    'must define a hint helper for Windows EPERM failures',
  );
  const fn = installScript.match(/function Write-WindowsEpermHint[\s\S]*?\n\}/);
  assert.ok(fn, 'must define Write-WindowsEpermHint body');
  const body = fn[0];
  assert.match(body, /Defender|antivirus/i, 'hint must mention AV / Defender as common cause');
  assert.match(body, /long path|LongPathsEnabled/i, 'hint must mention Windows long path support');
});

test('Step 5 install flow branches on error class instead of blind retry', () => {
  const step5Block = installScript.match(/Write-Step "Step 5\/9[\s\S]*?Write-Step "Step 6\/9/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  assert.match(
    block,
    /Test-LockfileMismatchFailure/,
    'Step 5 must call Test-LockfileMismatchFailure before deciding to retry',
  );
  assert.match(
    block,
    /Test-WindowsEpermFailure/,
    'Step 5 must call Test-WindowsEpermFailure to detect file-system errors',
  );
});

test('Step 5 no longer prints misleading "Frozen lockfile failed, retrying" for non-lockfile errors', () => {
  const step5Block = installScript.match(/Write-Step "Step 5\/9[\s\S]*?Write-Step "Step 6\/9/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  // The misleading retry message must now be gated behind a lockfile-mismatch check.
  // It is acceptable for the string to appear once, but only inside a branch that
  // first confirmed the error is actually a lockfile mismatch.
  const retryWarn = block.match(/Frozen lockfile[^\n]*retrying/);
  if (retryWarn) {
    const preceding = block.slice(0, block.indexOf(retryWarn[0]));
    assert.match(
      preceding,
      /Test-LockfileMismatchFailure/,
      'retry warning must appear AFTER Test-LockfileMismatchFailure check, not unconditionally',
    );
  }
});

test('Step 5 surfaces Windows EPERM hint when EPERM detected, instead of silently failing', () => {
  const step5Block = installScript.match(/Write-Step "Step 5\/9[\s\S]*?Write-Step "Step 6\/9/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  assert.match(
    block,
    /Write-WindowsEpermHint/,
    'Step 5 must call Write-WindowsEpermHint when EPERM/EBUSY/EACCES detected',
  );
});

test('Step 5 fails fast on non-lockfile errors instead of swapping to plain pnpm install', () => {
  // The fix: when frozen-lockfile fails for a reason that is NOT a lockfile mismatch
  // (e.g. EPERM unlink), we must NOT fall back to plain `pnpm install` — that just
  // repeats the same failure and buries the real error under a misleading message.
  const step5Block = installScript.match(/Write-Step "Step 5\/9[\s\S]*?Write-Step "Step 6\/9/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  // There must be a code path that exits 1 without invoking a second plain install
  // when the first failure is not a lockfile mismatch.
  assert.match(
    block,
    /Test-LockfileMismatchFailure[\s\S]*?\belse\b[\s\S]*?exit 1/,
    'must have an else-branch that exits without retrying when error is not a lockfile mismatch',
  );
});

// ── DEP0169 false-failure tolerance (codex bug-report root-cause #3 / #4) ──

test('Invoke-PnpmInstallWithCapturedOutput trusts $LASTEXITCODE over pipeline exceptions (DEP0169 tolerance)', () => {
  // Node 24 emits DEP0169 deprecation warnings to stderr. With $ErrorActionPreference=Stop,
  // the 2>&1 | Tee-Object pipeline can throw even when pnpm itself exited 0.
  // The catch path must check $LASTEXITCODE and treat exit 0 as success, not failure.
  const fn = installScript.match(/function Invoke-PnpmInstallWithCapturedOutput[\s\S]*?\n\}\n/);
  assert.ok(fn, 'must define Invoke-PnpmInstallWithCapturedOutput');
  const body = fn[0];
  // The catch block must reference $LASTEXITCODE so it can distinguish a real
  // process failure from a benign pipeline throw on stderr.
  const catchBlock = body.match(/} catch \{[\s\S]*?\}/);
  assert.ok(catchBlock, 'must have catch block');
  assert.match(
    catchBlock[0],
    /\$LASTEXITCODE\s*-eq\s*0/,
    'catch block must check $LASTEXITCODE -eq 0 to avoid DEP0169 false failures',
  );
});

test('Step 5 pins --store-dir + --package-import-method copy on Windows by default', () => {
  // pnpm 9 + npm-global pnpm.cmd + Node 24 on Windows hits
  // "Could not determine Node.js install directory" whenever pnpm install runs
  // without an explicit store-dir. The Windows reporter confirmed that the
  // very same command works once those two flags are passed. Step 5 must inject
  // them on every Invoke-PnpmInstallWithCapturedOutput call when running on
  // Windows; non-Windows platforms must NOT see the extra flags.
  const step5Block = installScript.match(/Write-Step "Step 5\/9[\s\S]*?Write-Step "Step 6\/9/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  assert.match(block, /Windows_NT|IsWindows/, 'Step 5 must guard the extra args on a Windows-only condition');
  assert.match(block, /LOCALAPPDATA/, 'Step 5 must derive the store dir from %LOCALAPPDATA%');
  assert.match(block, /--store-dir/, 'Step 5 must pass --store-dir on the default install invocation');
  assert.match(
    block,
    /--package-import-method[\s\S]{0,50}copy/,
    'Step 5 must pass --package-import-method copy to avoid hardlink failures',
  );
  // The injection must apply to the FIRST install attempt (not just a retry),
  // otherwise the initial pnpm.exe call still hits "Could not determine Node.js
  // install directory" on the same platforms.
  const firstInvokeIdx = block.indexOf('Invoke-PnpmInstallWithCapturedOutput');
  const storeDirIdx = block.indexOf('--store-dir');
  assert.ok(
    storeDirIdx >= 0 && firstInvokeIdx >= 0 && storeDirIdx < firstInvokeIdx,
    '--store-dir must appear BEFORE the first Invoke-PnpmInstallWithCapturedOutput so the first attempt already has it',
  );
});

test('Invoke-PnpmInstallWithCapturedOutput pins $LASTEXITCODE sentinel before pnpm call (codex P2)', () => {
  // $LASTEXITCODE is a process-global variable; PowerShell does NOT reset it on
  // `throw`. If Invoke-ToolCommand throws "command not found" before pnpm runs,
  // $LASTEXITCODE keeps whatever the previous native command left behind. Without
  // a sentinel a stale 0 would let the catch path return Ok=$true — fail-open.
  // Codex P2 fix: assign $LASTEXITCODE = -1 immediately before the Invoke-Pnpm
  // call so only a real pnpm.exe exit can overwrite it.
  const fn = installScript.match(/function Invoke-PnpmInstallWithCapturedOutput[\s\S]*?\n\}\n/);
  assert.ok(fn, 'must define Invoke-PnpmInstallWithCapturedOutput');
  const body = fn[0];
  // The sentinel must appear, and it must appear BEFORE the Invoke-Pnpm call so
  // that an Invoke-ToolCommand pre-execution throw cannot leave a stale 0 in place.
  const sentinelIdx = body.indexOf('$LASTEXITCODE = -1');
  const invokeIdx = body.indexOf('Invoke-Pnpm -CommandArgs');
  assert.ok(sentinelIdx >= 0, 'must set $LASTEXITCODE = -1 sentinel before invoking pnpm');
  assert.ok(invokeIdx >= 0, 'must invoke pnpm via Invoke-Pnpm');
  assert.ok(
    sentinelIdx < invokeIdx,
    'sentinel assignment must appear BEFORE Invoke-Pnpm so a pre-execution throw cannot leave stale $LASTEXITCODE',
  );
});
