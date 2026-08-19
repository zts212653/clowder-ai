/** Structural regression tests for the clowder-ai#1107 desktop metadata intake. */
const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const INSTALLER_DIR = path.join(__dirname, 'installer');

test('installer passes Version and installer InstallType', () => {
  const iss = readFileSync(path.join(INSTALLER_DIR, 'cat-cafe.iss'), 'utf8');
  assert.match(iss, /Parameters:.*generate-desktop-config\.ps1.*-Version/);
  assert.match(iss, /Parameters:.*generate-desktop-config\.ps1.*-InstallType\s+'installer'/);
});

test('portable launcher passes portable InstallType', () => {
  const bat = readFileSync(path.join(SCRIPTS_DIR, 'start-portable.bat'), 'utf8');
  assert.match(bat, /powershell.*generate-desktop-config\.ps1.*-InstallType\s+'portable'/i);
});

test('generator prefers desktop/package.json and has a complete fallback', () => {
  const ps1 = readFileSync(path.join(SCRIPTS_DIR, 'generate-desktop-config.ps1'), 'utf8');
  assert.match(ps1, /\$desktopPkgPath\s*=\s*Join-Path.*desktop.*package\.json/);
  assert.match(ps1, /if\s*\(Test-Path\s+\$desktopPkgPath\)\s*\{\s*\$desktopPkgPath\s*\}/);
  assert.match(ps1, /\$Version\s*=\s*"unknown"/);
});

test('portable staging bakes zipVersion into BOM-free desktop/package.json', () => {
  const buildScript = readFileSync(path.join(SCRIPTS_DIR, 'build-desktop.ps1'), 'utf8');
  const stagedPackageWrite =
    /\[System\.IO\.File\]::WriteAllText\(\(Join-Path\s+\$desktopDir\s+"package\.json"\),\s*\$json,\s*\(New-Object\s+System\.Text\.UTF8Encoding\s+\$false\)\)/;

  assert.match(buildScript, /\$desktopPkg\s*=\s*Join-Path.*desktop.*package\.json/);
  assert.match(buildScript, /\$pkgContent\.version\s*=\s*\$zipVersion/);
  assert.match(buildScript, stagedPackageWrite);

  const assignIdx = buildScript.search(/\$pkgContent\.version\s*=\s*\$zipVersion/);
  const writeIdx = buildScript.search(stagedPackageWrite);
  assert.ok(assignIdx >= 0 && writeIdx >= 0 && assignIdx < writeIdx);
});

test('desktop JSON writes never use BOM-emitting Out-File UTF-8', () => {
  const generator = readFileSync(path.join(SCRIPTS_DIR, 'generate-desktop-config.ps1'), 'utf8');
  assert.match(
    generator,
    /\[System\.IO\.File\]::WriteAllText\(\$configPath,\s*\$json,\s*\(New-Object\s+System\.Text\.UTF8Encoding\s+\$false\)\)/,
  );
  assert.doesNotMatch(generator, /Out-File[^\r\n]*-Encoding\s+utf8/);

  const buildScript = readFileSync(path.join(SCRIPTS_DIR, 'build-desktop.ps1'), 'utf8');
  assert.doesNotMatch(buildScript, /Out-File[^\r\n]*-Encoding\s+utf8/);
});

// ── F273: Plugin packaging source path regression (F204 migration) ──────
// After F204, plugins moved from root plugins/ to packages/api/src/plugins/.
// These tests ensure all three packaging configs point to the actual source
// and that the source directory contains the expected plugin manifests.

test('F273: Inno Setup plugins source points to packages/api/src/plugins', () => {
  const iss = readFileSync(path.join(INSTALLER_DIR, 'cat-cafe.iss'), 'utf8');
  assert.match(
    iss,
    /Source:.*packages\\api\\src\\plugins/,
    'Inno Setup must source plugins from packages/api/src/plugins',
  );
  assert.match(iss, /DestDir:.*\{app\}\\plugins/, 'Inno Setup must install plugins to {app}/plugins');
});

test('F273: electron-builder extraResources plugins source is packages/api/src/plugins', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const pluginResource = pkg.build?.extraResources?.find((r) => r.to === 'plugins');
  assert.ok(pluginResource, 'extraResources must include a plugins entry');
  assert.ok(
    pluginResource.from.includes('packages/api/src/plugins'),
    `plugins "from" must reference packages/api/src/plugins, got: ${pluginResource.from}`,
  );
});

test('F273: build-desktop.ps1 plugins source is packages/api/src/plugins', () => {
  const ps1 = readFileSync(path.join(SCRIPTS_DIR, 'build-desktop.ps1'), 'utf8');
  assert.match(
    ps1,
    /packages\\api\\src\\plugins/,
    'build-desktop.ps1 must source plugins from packages/api/src/plugins',
  );
});

test('F273: plugin source directory exists and contains github plugin manifest', () => {
  const pluginsSrc = path.join(__dirname, '..', 'packages', 'api', 'src', 'plugins');
  assert.ok(existsSync(pluginsSrc), `Plugin source directory must exist: ${pluginsSrc}`);
  const entries = readdirSync(pluginsSrc);
  assert.ok(entries.includes('github'), 'Plugin source must contain github plugin');
  const githubManifest = path.join(pluginsSrc, 'github', 'plugin.yaml');
  assert.ok(existsSync(githubManifest), 'github/plugin.yaml must exist');
});

test('desktop and root package versions remain distinct', () => {
  const rootPkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.notEqual(rootPkg.version, desktopPkg.version);
});
