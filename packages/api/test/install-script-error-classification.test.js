import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assert } from './install-script-test-helpers.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');
const installScript = readFileSync(resolve(repoRoot, 'scripts', 'install.ps1'), 'utf8');
const invokePnpmInstallFunctionPattern = /function Invoke-PnpmInstallWithCapturedOutput[\s\S]*?\r?\n\}\r?\n/;

function getInvokePnpmInstallFunctionBody() {
  const fn = installScript.match(invokePnpmInstallFunctionPattern);
  assert.ok(fn, 'must define Invoke-PnpmInstallWithCapturedOutput');
  return fn[0];
}

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
  const step5Block = installScript.match(/Write-Step "Step 5\/8[\s\S]*?Write-Step "Step 6\/8/);
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
  const step5Block = installScript.match(/Write-Step "Step 5\/8[\s\S]*?Write-Step "Step 6\/8/);
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
  const step5Block = installScript.match(/Write-Step "Step 5\/8[\s\S]*?Write-Step "Step 6\/8/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  assert.match(
    block,
    /Write-WindowsEpermHint/,
    'Step 5 must call Write-WindowsEpermHint when EPERM/EBUSY/EACCES detected',
  );
});

test('Step 5 plain-install retry passes --no-frozen-lockfile to override pnpm CI defaults (codex P1)', () => {
  // pnpm 8+ enables --frozen-lockfile by default whenever the CI env var is set.
  // Step 5's plain-install retry (taken after a lockfile-mismatch failure) is
  // ineffective in that environment unless we explicitly opt out: the retry
  // call must include --no-frozen-lockfile so it actually recovers from drift
  // (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH / ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE).
  const step5Block = installScript.match(/Write-Step "Step 5\/8[\s\S]*?Write-Step "Step 6\/8/);
  assert.ok(step5Block, 'must find Step 5 install block');
  const block = step5Block[0];
  // The retry call must appear AFTER the "Frozen lockfile failed, retrying"
  // warning (i.e. inside the lockfile-mismatch branch) and must contain
  // --no-frozen-lockfile.
  const retryWarnIdx = block.indexOf('Write-Warn "Frozen lockfile failed, retrying..."');
  assert.ok(retryWarnIdx >= 0, 'must have lockfile-mismatch retry warning');
  const retrySlice = block.slice(retryWarnIdx);
  assert.match(
    retrySlice,
    /\$plainInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs \(?@\([^)]*"--no-frozen-lockfile"[^)]*\)/,
    'plain install retry must pass --no-frozen-lockfile so the retry overrides pnpm CI defaults',
  );
});

test('Step 5 fails fast on non-lockfile errors instead of swapping to plain pnpm install', () => {
  // The fix: when frozen-lockfile fails for a reason that is NOT a lockfile mismatch
  // (e.g. EPERM unlink), we must NOT fall back to plain `pnpm install` — that just
  // repeats the same failure and buries the real error under a misleading message.
  const step5Block = installScript.match(/Write-Step "Step 5\/8[\s\S]*?Write-Step "Step 6\/8/);
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
  const body = getInvokePnpmInstallFunctionBody();
  // The catch block must reference $LASTEXITCODE so it can distinguish a real
  // process failure from a benign pipeline throw on stderr.
  const catchBlock = body.match(/} catch \{[\s\S]*?\}/);
  assert.ok(catchBlock, 'must have catch block');
  assert.match(
    catchBlock[0],
    /\$(?:global:)?LASTEXITCODE\s*-eq\s*0/,
    'catch block must check $LASTEXITCODE (optionally with $global: scope) -eq 0 to avoid DEP0169 false failures',
  );
});

test('Step 5 pins --store-dir + --package-import-method copy on Windows by default', () => {
  // pnpm 9 + npm-global pnpm.cmd + Node 24 on Windows hits
  // "Could not determine Node.js install directory" whenever pnpm install runs
  // without an explicit store-dir. The Windows reporter confirmed that the
  // very same command works once those two flags are passed. Step 5 must inject
  // them on every Invoke-PnpmInstallWithCapturedOutput call when running on
  // Windows; non-Windows platforms must NOT see the extra flags.
  const step5Block = installScript.match(/Write-Step "Step 5\/8[\s\S]*?Write-Step "Step 6\/8/);
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

test('Invoke-PnpmInstallWithCapturedOutput calls resolved pnpm directly inside the captured pipeline (砚砚 exit-code plumbing)', () => {
  // 砚砚's Windows / Node 24 repro showed that wrapping the pnpm call as
  // `Invoke-Pnpm ... | Tee-Object` returned Ok=False and left $LASTEXITCODE = -1
  // even when pnpm actually exited 0. Root cause: the nested function chain
  // (Invoke-Pnpm -> Invoke-ToolCommand -> & $toolCommand) hides the native exit
  // code from the captured pipeline. Fix: resolve pnpm up-front and invoke it
  // directly inside the captured pipeline (`& $pnpmCommand @CommandArgs 2>&1
  // | Tee-Object ...`) so the native command is the only producer of
  // $LASTEXITCODE in scope.
  const body = getInvokePnpmInstallFunctionBody();
  assert.match(body, /Resolve-PnpmCommand/, 'must resolve pnpm command upfront (not via Invoke-Pnpm wrapper)');
  // The captured pipeline must invoke the resolved pnpm command directly with
  // `& $pnpmCommand`, NOT through the Invoke-Pnpm wrapper, so PowerShell can
  // record the native exit code in $LASTEXITCODE reliably.
  assert.match(
    body,
    /&\s*\$pnpmCommand\s+@CommandArgs\s+2>&1\s*\|\s*Tee-Object/,
    'captured pipeline must call & $pnpmCommand @CommandArgs 2>&1 | Tee-Object directly',
  );
  assert.doesNotMatch(
    body,
    /Invoke-Pnpm\s+-CommandArgs\s+\$CommandArgs\s+2>&1\s*\|\s*Tee-Object/,
    'must NOT pipe Invoke-Pnpm into Tee-Object (hides native exit code from caller scope)',
  );
});

test('Invoke-PnpmInstallWithCapturedOutput reads $global:LASTEXITCODE explicitly to bypass PowerShell function scope shadowing', () => {
  // PowerShell 5.1 scoping quirk verified on the Windows reporter's box:
  // assigning `$LASTEXITCODE = -1` inside a function creates a function-local
  // copy that shadows the global automatic variable. When pnpm.exe runs and
  // exits 0, PowerShell updates `$global:LASTEXITCODE = 0`, but the
  // function-local `$LASTEXITCODE` stays at -1, so the success check still
  // observes the sentinel value and misclassifies the successful install.
  //
  // Fix: read and write $LASTEXITCODE via the explicit `$global:` scope
  // qualifier so PowerShell cannot shadow it into the function scope.
  const body = getInvokePnpmInstallFunctionBody();
  // Sentinel assignment must use $global:LASTEXITCODE so it actually pins the
  // global automatic variable instead of creating a shadowed local.
  assert.match(
    body,
    /\$global:LASTEXITCODE\s*=\s*-1/,
    'sentinel assignment must use $global:LASTEXITCODE = -1, not the function-local $LASTEXITCODE',
  );
  // Every read of the exit code must also use $global:LASTEXITCODE so we
  // observe pnpm's real exit value rather than the shadowed sentinel.
  const successCheck = body.match(/Ok\s*=\s*(\$[^\s]+)\s*-eq\s*0/);
  assert.ok(successCheck, 'must have an Ok = $... -eq 0 check on the success path');
  assert.equal(successCheck[1], '$global:LASTEXITCODE', 'success path must read $global:LASTEXITCODE explicitly');
  // The catch path must also read $global:LASTEXITCODE for the same reason.
  const catchBlock = body.match(/} catch \{[\s\S]*?\}\s*\}\s*finally/);
  assert.ok(catchBlock, 'must have catch block');
  assert.match(
    catchBlock[0],
    /\$global:LASTEXITCODE\s*-eq\s*0/,
    'catch path must read $global:LASTEXITCODE explicitly to detect pnpm success-with-pipeline-throw',
  );
});

test('Invoke-PnpmInstallWithCapturedOutput temporarily downgrades ErrorActionPreference during pnpm capture', () => {
  const body = getInvokePnpmInstallFunctionBody();
  const snapshotIdx = body.indexOf('$previousErrorActionPreference = $ErrorActionPreference');
  const downgradeIdx = body.indexOf('$ErrorActionPreference = "SilentlyContinue"');
  const invokeMatch = body.match(/&\s*\$pnpmCommand\s+@CommandArgs\s+2>&1\s*\|\s*Tee-Object/);
  const invokeIdx = invokeMatch ? invokeMatch.index : -1;
  const finallyIdx = body.indexOf('} finally {');
  const restoreIdx = body.indexOf('$ErrorActionPreference = $previousErrorActionPreference');

  assert.ok(snapshotIdx >= 0, 'must snapshot the incoming ErrorActionPreference');
  assert.ok(downgradeIdx >= 0, 'must temporarily downgrade ErrorActionPreference around pnpm capture');
  assert.ok(invokeIdx >= 0, 'must still invoke pnpm directly inside the captured pipeline');
  assert.ok(finallyIdx >= 0, 'must have a finally block for restoring function-local state');
  assert.ok(restoreIdx >= 0, 'must restore the previous ErrorActionPreference in finally');
  assert.ok(snapshotIdx < downgradeIdx, 'snapshot must happen before the temporary downgrade');
  assert.ok(downgradeIdx < invokeIdx, 'temporary downgrade must happen before the captured pnpm pipeline');
  assert.ok(finallyIdx < restoreIdx, 'restore must happen inside the finally block');
});

test('Invoke-PnpmInstallWithCapturedOutput pins $LASTEXITCODE sentinel before pnpm call (codex P2)', () => {
  // $LASTEXITCODE is a process-global variable; PowerShell does NOT reset it on
  // `throw`. Without a sentinel a stale value (possibly 0) from earlier native
  // commands would let the catch path return Ok=$true — fail-open. Codex P2
  // fix: assign $LASTEXITCODE = -1 immediately before the pnpm invocation so
  // only a real pnpm.exe exit can overwrite it.
  const body = getInvokePnpmInstallFunctionBody();
  // The sentinel must appear, and it must appear BEFORE the direct pnpm call
  // so any pre-execution throw cannot leave a stale 0 in place. The direct
  // call form is `& $pnpmCommand @CommandArgs` (砚砚 exit-code plumbing fix).
  const sentinelIdx = body.indexOf('$LASTEXITCODE = -1');
  const invokeMatch = body.match(/&\s*\$pnpmCommand\s+@CommandArgs/);
  const invokeIdx = invokeMatch ? invokeMatch.index : -1;
  assert.ok(sentinelIdx >= 0, 'must set $LASTEXITCODE = -1 sentinel before invoking pnpm');
  assert.ok(invokeIdx >= 0, 'must invoke pnpm directly via & $pnpmCommand @CommandArgs');
  assert.ok(
    sentinelIdx < invokeIdx,
    'sentinel assignment must appear BEFORE the pnpm invocation so a pre-execution throw cannot leave stale $LASTEXITCODE',
  );
});
