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

test('windows desktop build script restores npm_config_bin_links after deploy', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  assert.match(buildScript, /\$prevBinLinks = \$env:npm_config_bin_links/);
  assert.match(buildScript, /\$env:npm_config_bin_links = "false"/);
  assert.match(
    buildScript,
    /if \(\$null -eq \$prevBinLinks\)\s*\{\s*Remove-Item Env:npm_config_bin_links -ErrorAction SilentlyContinue/s,
  );
  assert.match(buildScript, /else\s*\{\s*\$env:npm_config_bin_links = \$prevBinLinks/s);
});
