import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
const desktopBuildScriptPath = path.resolve(import.meta.dirname, '../../../desktop/scripts/build-desktop.ps1');

test('api build script avoids unix-only file copy commands', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const buildScript = packageJson.scripts?.build;

  assert.equal(typeof buildScript, 'string');
  assert.match(buildScript, /node \.\/scripts\/copy-marketplace-catalog-data\.mjs/);
  assert.doesNotMatch(buildScript, /\bmkdir -p\b/);
  assert.doesNotMatch(buildScript, /\bcp\s+src\/marketplace\/catalog-data/);
});

test('windows desktop build script cleans up temporary Defender exclusions', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  assert.match(buildScript, /Add-MpPreference -ExclusionPath \$deployRoot/);
  assert.match(buildScript, /Remove-MpPreference -ExclusionPath \$deployRoot/);
  assert.match(buildScript, /finally\s*\{[\s\S]*Remove-MpPreference -ExclusionPath \$deployRoot[\s\S]*\}/);
});

test('windows desktop build script disables bin-links via pnpm user-level config', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  assert.match(buildScript, /pnpm config set bin-links false/);
  assert.match(buildScript, /pnpm config delete bin-links/);
  assert.match(buildScript, /finally\s*\{[\s\S]*pnpm config delete bin-links[\s\S]*\}/);
});

test('windows desktop build script cleans up both pnpm config and Defender in finally block', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  const finallyMatch = buildScript.match(/finally\s*\{([\s\S]*?)\}\s*\n\s*if \(\$deployFailed\)/);
  assert.ok(finallyMatch, 'finally block with cleanup must exist');
  const finallyBody = finallyMatch[1];
  assert.match(finallyBody, /pnpm config delete bin-links/);
  assert.match(finallyBody, /Remove-MpPreference -ExclusionPath \$deployRoot/);
});
