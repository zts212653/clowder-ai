/**
 * Structural regression tests for #1107 — desktop-config.json generation.
 *
 * These tests validate the PowerShell/Batch script content structurally
 * (source patterns, execution order) and run on all platforms.
 * Behavioral tests that execute the script on Windows are in
 * generate-desktop-config-behavior.test.js (Windows Smoke CI).
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const INSTALLER_DIR = path.join(__dirname, 'installer');

test('#1107: Inno Setup installer passes -Version explicitly', () => {
  const iss = readFileSync(path.join(INSTALLER_DIR, 'cat-cafe.iss'), 'utf8');
  // Match the actual Parameters line that invokes the script with -Version.
  // A comment mentioning -Version is not enough — the real invocation must exist.
  assert.match(
    iss,
    /Parameters:.*generate-desktop-config\.ps1.*-Version/,
    'cat-cafe.iss Parameters must invoke generate-desktop-config.ps1 with -Version',
  );
});

test('#1107: Inno Setup installer passes -InstallType installer', () => {
  const iss = readFileSync(path.join(INSTALLER_DIR, 'cat-cafe.iss'), 'utf8');
  assert.match(
    iss,
    /Parameters:.*generate-desktop-config\.ps1.*-InstallType\s+'installer'/,
    'cat-cafe.iss Parameters must pass -InstallType installer',
  );
});

test('#1107: Portable launcher passes -InstallType portable', () => {
  const bat = readFileSync(path.join(SCRIPTS_DIR, 'start-portable.bat'), 'utf8');
  // Match the actual powershell invocation line, not a rem comment
  assert.match(
    bat,
    /powershell.*generate-desktop-config\.ps1.*-InstallType\s+'portable'/i,
    'start-portable.bat must invoke generate-desktop-config.ps1 with -InstallType portable',
  );
});

test('#1107: PowerShell script resolves version from desktop/package.json first', () => {
  const ps1 = readFileSync(path.join(SCRIPTS_DIR, 'generate-desktop-config.ps1'), 'utf8');

  // Match the actual variable assignment that constructs the desktop path,
  // not just any mention of the string in a comment.
  assert.match(
    ps1,
    /\$desktopPkgPath\s*=\s*Join-Path.*desktop.*package\.json/,
    'generate-desktop-config.ps1 must assign $desktopPkgPath from desktop/package.json',
  );

  // The conditional must prefer $desktopPkgPath over $rootPkgPath
  assert.match(
    ps1,
    /if\s*\(Test-Path\s+\$desktopPkgPath\)\s*\{\s*\$desktopPkgPath\s*\}/,
    'generate-desktop-config.ps1 must prefer $desktopPkgPath when it exists',
  );
});

test('#1107: version fallback chain is complete', () => {
  const ps1 = readFileSync(path.join(SCRIPTS_DIR, 'generate-desktop-config.ps1'), 'utf8');
  // Must have a final fallback to "unknown" if all sources fail
  assert.match(ps1, /\$Version\s*=\s*"unknown"/, 'Must fall back to "unknown" if no package.json is readable');
});

test('#1107: build script bakes resolved version into staged desktop/package.json', () => {
  const buildScript = readFileSync(path.join(SCRIPTS_DIR, 'build-desktop.ps1'), 'utf8');
  // Exact regex for the staged package.json write — pins UTF8Encoding($false)
  // so that a $true mutation (which silently re-enables the BOM) is caught.
  const stagedPackageWrite =
    /\[System\.IO\.File\]::WriteAllText\(\(Join-Path\s+\$desktopDir\s+"package\.json"\),\s*\$json,\s*\(New-Object\s+System\.Text\.UTF8Encoding\s+\$false\)\)/;

  // Must read the source desktop/package.json
  assert.match(
    buildScript,
    /\$desktopPkg\s*=\s*Join-Path.*desktop.*package\.json/,
    'build-desktop.ps1 must locate source desktop/package.json',
  );

  // Must write $zipVersion into the staged copy (not just Copy-Item)
  // so that CATCAFE_VERSION overrides propagate to portable config.
  assert.match(
    buildScript,
    /\$pkgContent\.version\s*=\s*\$zipVersion/,
    'build-desktop.ps1 must bake $zipVersion into staged desktop/package.json',
  );

  // Must serialize the modified content back to the staging directory using
  // BOM-less UTF-8 (WriteAllText + UTF8Encoding($false)), not Out-File.
  assert.match(
    buildScript,
    stagedPackageWrite,
    'build-desktop.ps1 must write staged package.json via WriteAllText with UTF8Encoding($false)',
  );

  // Execution order: version assignment MUST precede serialization.
  // If WriteAllText runs before $pkgContent.version = $zipVersion, the
  // written JSON still carries the old version — a silent data bug.
  const assignIdx = buildScript.search(/\$pkgContent\.version\s*=\s*\$zipVersion/);
  const writeIdx = buildScript.search(stagedPackageWrite);
  assert.ok(assignIdx >= 0 && writeIdx >= 0, 'Both version-bake and serialization lines must exist');
  assert.ok(
    assignIdx < writeIdx,
    `Version assignment (pos ${assignIdx}) must appear before serialization (pos ${writeIdx})`,
  );
});

test('#1107: no JSON file is written with BOM-emitting Out-File -Encoding utf8', () => {
  // Guard: Windows PowerShell 5.1's Out-File -Encoding utf8 emits a UTF-8 BOM
  // (ef bb bf) that breaks JSON.parse. All JSON writes in desktop scripts must
  // use [System.IO.File]::WriteAllText with UTF8Encoding($false) instead.
  const scripts = ['generate-desktop-config.ps1', 'build-desktop.ps1'];
  for (const name of scripts) {
    const content = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    // Match Out-File writing a .json path with -Encoding utf8
    assert.doesNotMatch(
      content,
      /Out-File.*\.json.*-Encoding\s+utf8/,
      `${name} must not use Out-File -Encoding utf8 for JSON files (emits BOM on PS 5.1)`,
    );
  }
});

test('#1107: desktop/package.json version differs from root', () => {
  // Guard: if these versions ever converge, the fallback chain becomes
  // irrelevant and this test should be updated. If they differ, the
  // generate-desktop-config.ps1 MUST prefer desktop/package.json.
  const rootPkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.notEqual(
    rootPkg.version,
    desktopPkg.version,
    'Root and desktop versions should differ — if they converge, update this test and the fallback logic',
  );
});
