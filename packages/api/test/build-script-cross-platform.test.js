import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
const desktopPackageJsonPath = path.resolve(import.meta.dirname, '../../../desktop/package.json');
const desktopMainPath = path.resolve(import.meta.dirname, '../../../desktop/main.js');
const desktopBuildScriptPath = path.resolve(import.meta.dirname, '../../../desktop/scripts/build-desktop.ps1');
const desktopMacBuildScriptPath = path.resolve(import.meta.dirname, '../../../desktop/scripts/build-mac.sh');
const desktopPostInstallScriptPath = path.resolve(
  import.meta.dirname,
  '../../../desktop/scripts/post-install-offline.ps1',
);
const desktopInstallerScriptPath = path.resolve(import.meta.dirname, '../../../desktop/installer/cat-cafe.iss');

test('api build script avoids unix-only file copy commands', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const buildScript = packageJson.scripts?.build;

  assert.equal(typeof buildScript, 'string');
  assert.match(buildScript, /node \.\/scripts\/copy-marketplace-catalog-data\.mjs/);
  assert.doesNotMatch(buildScript, /\bmkdir -p\b/);
  assert.doesNotMatch(buildScript, /\bcp\s+src\/marketplace\/catalog-data/);
});

test('desktop package includes main process local require dependencies', async () => {
  const desktopPackage = JSON.parse(await readFile(desktopPackageJsonPath, 'utf8'));
  const mainSource = await readFile(desktopMainPath, 'utf8');
  const packageFiles = new Set(desktopPackage.build?.files ?? []);
  const missing = [];

  for (const match of mainSource.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
    const specifier = match[1];
    let relativePath = specifier.slice('./'.length);
    if (!path.extname(relativePath)) relativePath += '.js';
    relativePath = relativePath.split(path.sep).join('/');
    if (!packageFiles.has(relativePath)) missing.push(relativePath);
  }

  assert.deepEqual(missing, []);
});

test('windows desktop build script cleans up temporary Defender exclusions', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  assert.match(buildScript, /Add-MpPreference -ExclusionPath \$deployRoot/);
  assert.match(buildScript, /Remove-MpPreference -ExclusionPath \$deployRoot/);
  assert.match(buildScript, /finally\s*\{[\s\S]*Remove-MpPreference -ExclusionPath \$deployRoot[\s\S]*\}/);
});

test('windows desktop build script retries pnpm deploy on EPERM', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  assert.match(buildScript, /for \(\$attempt = 1; \$attempt -le 3/);
  assert.match(buildScript, /Start-Sleep -Seconds 10/);
  assert.match(buildScript, /Remove-Item \$out -Recurse -Force/);
});

test('windows desktop build script Defender cleanup runs in finally block', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  const finallyMatch = buildScript.match(/finally\s*\{([\s\S]*?)\}\s*\n\s*if \(\$deployFailed\)/);
  assert.ok(finallyMatch, 'finally block with cleanup must exist');
  assert.match(finallyMatch[1], /Remove-MpPreference -ExclusionPath \$deployRoot/);
});

test('F210 desktop packaging records Antigravity CLI native install policy instead of npm packing Gemini CLI', async () => {
  const macBuildScript = await readFile(desktopMacBuildScriptPath, 'utf8');
  const windowsBuildScript = await readFile(desktopBuildScriptPath, 'utf8');
  const postInstallScript = await readFile(desktopPostInstallScriptPath, 'utf8');
  const installerScript = await readFile(desktopInstallerScriptPath, 'utf8');

  for (const [name, content] of [
    ['build-mac.sh', macBuildScript],
    ['build-desktop.ps1', windowsBuildScript],
  ]) {
    assert.match(content, /agy-install-instructions\.txt/, `${name} should ship explicit AGY install guidance`);
    assert.match(
      content,
      /https:\/\/antigravity\.google\/cli\/install/,
      `${name} should point at official AGY bootstrapper`,
    );
    assert.doesNotMatch(content, /@google\/gemini-cli/, `${name} must not pack Gemini CLI as the AGY replacement`);
  }

  assert.match(postInstallScript, /\[switch\]\$Antigravity/);
  assert.match(postInstallScript, /Name = "agy"; Label = "Antigravity CLI"/);
  assert.match(postInstallScript, /https:\/\/antigravity\.google\/cli\/install\.cmd/);
  assert.match(
    postInstallScript,
    /function Test-AntigravityCliBootstrapperAvailable \{[\s\S]*?https:\/\/antigravity\.google\/cli\/install\.cmd/s,
    'offline post-install should probe the AGY bootstrapper endpoint, not npm, before AGY install',
  );
  assert.match(
    postInstallScript,
    /if \(\$tool\.Kind -eq "antigravity-native"\) \{[\s\S]*?if \(Test-AntigravityCliBootstrapperAvailable\) \{[\s\S]*?Install-AntigravityCliFromNetwork/s,
    'offline post-install must gate AGY bootstrapper on AGY-specific reachability',
  );
  assert.match(
    postInstallScript,
    /Write-Warn "Antigravity CLI requires the official network bootstrapper/s,
    'offline post-install should explain why AGY was skipped when network is unavailable',
  );
  assert.match(
    postInstallScript,
    /if \(-not \$installed -and \$hasNetwork -and \$tool\.Kind -ne "antigravity-native"\)/,
    'AGY bootstrapper failures must not fall through to the generic npm fallback',
  );
  assert.doesNotMatch(postInstallScript, /Name = "gemini"; Label = "Gemini"; Pkg = "@google\/gemini-cli"/);

  assert.match(installerScript, /Name: "cli_antigravity";\s+Description: "Antigravity CLI \(Google agy\)"/);
  assert.match(installerScript, /-Antigravity \{code:BoolComponent\|cli_antigravity\}/);
  assert.doesNotMatch(installerScript, /cli_gemini/);
});
