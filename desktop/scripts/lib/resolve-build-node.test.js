/**
 * Behavioral tests for lib/Resolve-BuildNode.ps1 — Windows only.
 *
 * build-desktop.ps1 bundles a portable Node runtime, so the build host's Node
 * must both match the ABI of the compiled native modules and satisfy the repo's
 * declared engines.node. The previous implementation guessed "v22.12.0" when
 * detection failed, which silently produced an installer whose API could not
 * load better-sqlite3.
 *
 * `GetNodeVersion` is injectable, so these tests drive the real production
 * function without touching PATH.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const IS_WINDOWS = os.platform() === 'win32';
const LIB = path.join(__dirname, 'Resolve-BuildNode.ps1');
const POWERSHELL_TIMEOUT_MS = 60_000;

const DRIVER = `
param(
    [Parameter(Mandatory)] [string]$Lib,
    [Parameter(Mandatory)] [string]$Root
)
. $Lib
$results = New-Object System.Collections.ArrayList

function Add-Result {
    param([string]$Name, [bool]$Threw, [string]$Message, [string]$Value)
    [void]$results.Add(@{ name = $Name; threw = $Threw; message = $Message; value = $Value })
}

function Invoke-Case {
    param([string]$Name, [scriptblock]$GetNodeVersion)
    try {
        $value = Resolve-BuildNodeVersion -ProjectRoot $Root -GetNodeVersion $GetNodeVersion
        Add-Result -Name $Name -Threw $false -Message '' -Value "$value"
    } catch {
        Add-Result -Name $Name -Threw $true -Message $_.Exception.Message -Value ''
    }
}

Invoke-Case -Name 'missing'   -GetNodeVersion { $null }
Invoke-Case -Name 'older'     -GetNodeVersion { 'v22.12.0' }
Invoke-Case -Name 'current'   -GetNodeVersion { 'v24.16.0' }
Invoke-Case -Name 'newer'     -GetNodeVersion { 'v26.1.0' }
Invoke-Case -Name 'garbage'   -GetNodeVersion { 'not-a-version' }
Invoke-Case -Name 'padded'    -GetNodeVersion { "  v24.16.0  " }
Invoke-Case -Name 'noOutput'  -GetNodeVersion { throw 'boom' }

$results | ConvertTo-Json -Depth 5 -Compress
`;

const tmpDirs = [];

function makeProject(enginesNode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-buildnode-'));
  tmpDirs.push(dir);
  const pkg = enginesNode === null ? {} : { engines: { node: enginesNode } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return dir;
}

function runDriver(projectRoot) {
  const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-buildnode-driver-'));
  tmpDirs.push(driverDir);
  const driverPath = path.join(driverDir, 'driver.ps1');
  fs.writeFileSync(driverPath, DRIVER);

  const stdout = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driverPath, '-Lib', LIB, '-Root', projectRoot],
    { encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const byName = {};
  for (const row of JSON.parse(stdout.trim())) byName[row.name] = row;
  return byName;
}

describe(
  'desktop/lib/Resolve-BuildNode.ps1 behavior',
  { skip: !IS_WINDOWS && 'PowerShell required (Windows only)' },
  () => {
    afterEach(() => {
      while (tmpDirs.length > 0) {
        fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
      }
    });

    it('rejects an undetectable Node instead of guessing a version', () => {
      const results = runDriver(makeProject('>=24.0.0'));

      assert.equal(results.missing.threw, true);
      assert.match(results.missing.message, /Cannot detect the build-machine Node version/);
      assert.match(results.missing.message, /Why:/);
      assert.match(results.missing.message, /Fix: install Node >= 24/);
      // A thrown GetNodeVersion must be treated the same way as no output.
      assert.equal(results.noOutput.threw, true);
    });

    it('rejects a Node older than the engines.node requirement', () => {
      const results = runDriver(makeProject('>=24.0.0'));

      assert.equal(results.older.threw, true);
      assert.match(results.older.message, /v22\.12\.0 is older than the >=24/);
      assert.match(results.older.message, /Fix: upgrade to Node >= 24/);
    });

    it('accepts a Node that satisfies the requirement', () => {
      const results = runDriver(makeProject('>=24.0.0'));

      assert.equal(results.current.threw, false);
      assert.equal(results.current.value, 'v24.16.0');
      assert.equal(results.newer.threw, false);
      assert.equal(results.newer.value, 'v26.1.0');
      assert.equal(results.padded.threw, false);
      assert.equal(results.padded.value, 'v24.16.0');
    });

    it('rejects an unparseable version rather than defaulting', () => {
      const results = runDriver(makeProject('>=24.0.0'));

      assert.equal(results.garbage.threw, true);
      assert.match(results.garbage.message, /Cannot parse the build-machine Node version/);
      assert.match(results.garbage.message, /Fix:/);
    });

    it('reads the requirement from package.json instead of hardcoding a major', () => {
      // v22 satisfies >=22 — the check must follow the declared requirement.
      const lenient = runDriver(makeProject('>=22.0.0'));
      assert.equal(lenient.older.threw, false);
      assert.equal(lenient.older.value, 'v22.12.0');

      // With no engines.node declared there is nothing to enforce.
      const undeclared = runDriver(makeProject(null));
      assert.equal(undeclared.older.threw, false);
      assert.equal(undeclared.older.value, 'v22.12.0');
    });
  },
);
