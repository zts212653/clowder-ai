import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
const desktopPackageJsonPath = path.resolve(import.meta.dirname, '../../../desktop/package.json');
const desktopMainPath = path.resolve(import.meta.dirname, '../../../desktop/main.js');
const desktopBuildScriptPath = path.resolve(import.meta.dirname, '../../../desktop/scripts/build-desktop.ps1');

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
