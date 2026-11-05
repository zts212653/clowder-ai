const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'scripts/build-desktop.ps1'), 'utf8');
const windows = process.platform === 'win32';
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
function fixture(t) {
  // GitHub Windows TEMP uses an 8.3 alias; Get-Item returns its expanded path.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['desktop/scripts', 'desktop/node_modules/electron', 'dist'])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'desktop/package.json'), JSON.stringify({ version: '1.14.0' }));
  fs.writeFileSync(
    path.join(root, 'desktop/package-lock.json'),
    JSON.stringify({ packages: { '': { devDependencies: { electron: '35.7.5' } } } }),
  );
  fs.writeFileSync(
    path.join(root, 'desktop/node_modules/electron/package.json'),
    JSON.stringify({ version: '35.7.5' }),
  );
  return root;
}
function run(root, code, args = []) {
  const script = path.join(root, 'desktop/scripts/probe.ps1');
  fs.writeFileSync(script, code);
  const env = { ...process.env };
  // A parent pwsh process can leave only PowerShell 7's module search paths.
  delete env.PSModulePath;
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env,
  });
}
const mocks = `
function Write-Step {} function Write-Ok {} function Write-Warn {} function Write-Err {}
function git { $global:LASTEXITCODE = 0; if ($args -contains 'rev-parse') { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
`;
const manifest = source.slice(source.indexOf('# Step 9:'));
function manifestScript(root, extras = '') {
  return `$ErrorActionPreference = 'Stop'
$ProjectRoot = ${quote(root)}
$integrityTool = 'fixture-integrity'
$generatedSetupPath = $null
$generatedPortablePath = $null
${mocks}
function node { $global:LASTEXITCODE = 0; '{"after":"High","changed":false}' }
${extras}
${manifest}`;
}

test('release refuses an unverified skipped Electron shell before building anything', { skip: !windows }, (t) => {
  const root = fixture(t);
  const prefix = source
    .slice(0, source.indexOf('# Step 1:'))
    .replace('$ErrorActionPreference = "Stop"', `$ErrorActionPreference = "Stop"\n${mocks}`);
  const result = run(root, prefix, ['-SkipElectronBuild']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /SkipElectronBuild/);
});

test('release refuses disabling its manifest while diagnostic skip remains explicit', { skip: !windows }, (t) => {
  const root = fixture(t);
  const prefix = source
    .slice(0, source.indexOf('# Step 1:'))
    .replace('$ErrorActionPreference = "Stop"', `$ErrorActionPreference = "Stop"\n${mocks}`);
  assert.notEqual(run(root, prefix, ['-NoManifest']).status, 0);
  const diagnostic = run(root, prefix, ['-SkipElectronBuild', '-NoManifest', '-AllowDirtyInputs']);
  assert.equal(diagnostic.status, 0, diagnostic.stdout + diagnostic.stderr);
});

test('every Electron build runs npm ci even when the installed Electron version matches', { skip: !windows }, (t) => {
  const root = fixture(t);
  const section = source.slice(source.indexOf('# Step 5:'), source.indexOf('    $electronOutput ='));
  const result = run(
    root,
    `$ErrorActionPreference = 'Stop'
$ProjectRoot = ${quote(root)}
${mocks}
function npm { $global:LASTEXITCODE = 0; Set-Content -LiteralPath ${quote(path.join(root, 'npm-args.txt'))} -Value ($args -join ' ') }
function npx { $global:LASTEXITCODE = 0 }
${section}
}`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'npm-args.txt')), true, 'locked desktop dependencies were not installed');
  assert.equal(fs.readFileSync(path.join(root, 'npm-args.txt'), 'utf8').trim(), 'ci --include=dev');
});

test('a manifest never assigns skipped old installers or ZIPs to this build', { skip: !windows }, (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'dist/ClowderAI-Setup-old.exe'), 'old setup');
  fs.writeFileSync(path.join(root, 'dist/ClowderAI-old.zip'), 'old zip');
  const result = run(root, manifestScript(root));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8'));
  assert.equal(record.installer, null);
  assert.equal(record.portableZip, null);
});

test('a manifest records the generated file even when another Setup is newer', { skip: !windows }, (t) => {
  const root = fixture(t);
  const generated = path.join(root, 'dist/ClowderAI-Setup-current.exe');
  fs.writeFileSync(generated, 'current setup');
  fs.utimesSync(generated, new Date(0), new Date(0));
  fs.writeFileSync(path.join(root, 'dist/ClowderAI-Setup-other.exe'), 'unrelated setup');
  const result = run(root, manifestScript(root, `$generatedSetupPath = ${quote(generated)}`));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8'));
  assert.equal(record.installer.path, 'dist/ClowderAI-Setup-current.exe');
  assert.equal(record.installer.sha256, createHash('sha256').update('current setup').digest('hex'));
  assert.equal(record.diagnosticOnly, false);
});

test('release manifest write errors fail the build instead of returning success', { skip: !windows }, (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'dist/build-manifest.json'));
  const result = run(root, manifestScript(root));
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

test('release refuses a generated artifact that disappears before manifest creation', { skip: !windows }, (t) => {
  const root = fixture(t);
  const result = run(root, manifestScript(root, `$generatedSetupPath = ${quote(path.join(root, 'missing.exe'))}`));
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
});

test('diagnostic reuse is marked in the manifest and cannot masquerade as a release', { skip: !windows }, (t) => {
  const root = fixture(t);
  const result = run(root, manifestScript(root, '$AllowDirtyInputs = $true; $SkipElectronBuild = $true'));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8'));
  assert.equal(record.diagnosticOnly, true);
  assert.equal(record.skippedElectronBuild, true);
  assert.equal(record.installer, null);
});
