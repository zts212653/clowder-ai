/** Structural regression tests for the clowder-ai#1107 desktop metadata intake. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
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

// C1: plugins are installed by the packaged Host Manager, not copied from Host source.
test('desktop distributions include the API that owns plugin installation', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.some((r) => r.from === '../bundled/deploy/api' && r.to === 'packages/api'));
  const ps1 = readFileSync(path.join(SCRIPTS_DIR, 'build-desktop.ps1'), 'utf8');
  assert.match(ps1, /Copy-ToStaging \(Join-Path \$deployRoot "api"\)\s+"packages\\api"/);
  const iss = readFileSync(path.join(INSTALLER_DIR, 'cat-cafe.iss'), 'utf8');
  assert.match(iss, /Source:.*deploy-api\.tar\.gz/);
  // The branch extracts archives through the packaged extractor (integrity +
  // progress) instead of a literal tar Parameters line.
  assert.match(iss, /AfterInstall: ExtractRuntimeArchive\('deploy-api\.tar\.gz'\)/);
  const extractor = readFileSync(path.join(SCRIPTS_DIR, 'extract-runtime-archive.cjs'), 'utf8');
  assert.match(extractor, /'deploy-api': \['packages\/api'/);
});

test('desktop distributions do not bundle retired Host business-plugin sources', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.equal(
    pkg.build.extraResources.some((r) => r.to === 'plugins'),
    false,
  );
  for (const file of [path.join(INSTALLER_DIR, 'cat-cafe.iss'), path.join(SCRIPTS_DIR, 'build-desktop.ps1')]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /packages[\\/]api[\\/]src[\\/]plugins/);
  }
});

test('desktop and root package versions remain distinct', () => {
  const rootPkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const desktopPkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.notEqual(rootPkg.version, desktopPkg.version);
});

for (const { requestedVersion, expected, description } of [
  { requestedVersion: '0.14.0', expected: '0.14.0', description: '0.14.0' },
  { requestedVersion: '', expected: require('./package.json').version, description: 'the committed package version' },
]) {
  test(`Windows shell packages ${description} without editing release inputs`, () => {
    const packagePath = path.join(__dirname, 'package.json');
    const original = readFileSync(packagePath, 'utf8');
    const result = spawnSync(
      process.execPath,
      ['-e', 'console.log(JSON.stringify(require("./windows-builder.cjs")))'],
      { cwd: __dirname, encoding: 'utf8', env: { CATCAFE_VERSION: requestedVersion } },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).extraMetadata?.version, expected);
    assert.equal(readFileSync(packagePath, 'utf8'), original);
  });

  test(
    `macOS shell packages ${description} without editing release inputs`,
    { skip: process.platform === 'win32' },
    () => {
      const packagePath = path.join(__dirname, 'package.json');
      const original = readFileSync(packagePath, 'utf8');
      const buildScript = readFileSync(path.join(SCRIPTS_DIR, 'build-mac.sh'), 'utf8');
      const start = buildScript.indexOf('# Build .app bundles only');
      const end = buildScript.indexOf('# Ad-hoc sign each .app');
      assert.ok(start >= 0 && end > start, 'exercise the actual Electron packaging command');
      const result = spawnSync(
        'bash',
        [
          '-c',
          [
            'set -euo pipefail',
            'ARCHS=(arm64)',
            'npx() { node -e \'console.log(JSON.stringify(process.argv.slice(1)))\' "$@"; }',
            buildScript.slice(start, end),
          ].join('\n'),
        ],
        { cwd: __dirname, encoding: 'utf8', env: { PATH: process.env.PATH, CATCAFE_VERSION: requestedVersion } },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const builderArgs = JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith('[')));
      assert.ok(builderArgs.includes(`--config.extraMetadata.version=${expected}`), JSON.stringify(builderArgs));
      assert.equal(readFileSync(packagePath, 'utf8'), original);
    },
  );
}
