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

test('api test script builds mcp-server with workspace dependencies first', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const testScript = packageJson.scripts?.test;

  assert.equal(typeof testScript, 'string');
  assert.match(testScript, /pnpm --filter @cat-cafe\/mcp-server\.\.\. build/);
  assert.doesNotMatch(
    testScript,
    /pnpm --dir \.\.\/mcp-server build/,
    'direct mcp-server build can run before workspace deps have dist artifacts',
  );
  assert.ok(
    testScript.indexOf('pnpm --filter @cat-cafe/mcp-server... build') < testScript.indexOf('pnpm run build'),
    'mcp-server dependency build must run before API build/test execution',
  );
});

test('desktop package includes the full main process local require dependency graph', async () => {
  const desktopPackage = JSON.parse(await readFile(desktopPackageJsonPath, 'utf8'));
  const packageFiles = new Set(desktopPackage.build?.files ?? []);
  const desktopRoot = path.dirname(desktopMainPath);
  const pending = ['main.js'];
  const visited = new Set();
  const missing = [];

  while (pending.length > 0) {
    const relativeSourcePath = pending.shift();
    if (visited.has(relativeSourcePath)) continue;
    visited.add(relativeSourcePath);

    const source = await readFile(path.join(desktopRoot, relativeSourcePath), 'utf8');
    for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const specifier = match[1];
      let dependencyPath = path.relative(
        desktopRoot,
        path.resolve(desktopRoot, path.dirname(relativeSourcePath), specifier),
      );
      if (!path.extname(dependencyPath)) dependencyPath += '.js';
      dependencyPath = dependencyPath.split(path.sep).join('/');
      if (path.extname(dependencyPath) !== '.js') continue;
      if (!packageFiles.has(dependencyPath)) {
        missing.push(dependencyPath);
        continue;
      }
      pending.push(dependencyPath);
    }
  }

  assert.deepEqual([...new Set(missing)].sort(), []);
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

test('windows desktop build script downloads official Inno Setup ChineseSimplified language file', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  assert.match(
    buildScript,
    /https:\/\/raw\.githubusercontent\.com\/jrsoftware\/issrc\/main\/Files\/Languages\/ChineseSimplified\.isl/,
  );
  assert.doesNotMatch(
    buildScript,
    /Files\/Languages\/Unofficial\/ChineseSimplified\.isl/,
    'ChineseSimplified.isl is now an official Inno Setup language file; the old Unofficial URL 404s',
  );
});

test('windows desktop build script Defender cleanup runs in finally block', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');

  const finallyMatch = buildScript.match(/finally\s*\{([\s\S]*?)\}\s*\n\s*if \(\$deployFailed\)/);
  assert.ok(finallyMatch, 'finally block with cleanup must exist');
  assert.match(finallyMatch[1], /Remove-MpPreference -ExclusionPath \$deployRoot/);
});

test('F210 desktop packaging does not bundle Gemini CLI as AGY replacement', async () => {
  const macBuildScript = await readFile(desktopMacBuildScriptPath, 'utf8');
  const windowsBuildScript = await readFile(desktopBuildScriptPath, 'utf8');
  const postInstallScript = await readFile(desktopPostInstallScriptPath, 'utf8');
  const installerScript = await readFile(desktopInstallerScriptPath, 'utf8');

  // Build script ships AGY install guidance (instructions file in portable zip)
  // rather than npm-packing @google/gemini-cli as a drop-in replacement.
  assert.match(
    windowsBuildScript,
    /agy-install-instructions\.txt/,
    'build-desktop.ps1 should ship explicit AGY install guidance',
  );
  assert.match(
    windowsBuildScript,
    /https:\/\/antigravity\.google\/cli\/install/,
    'build-desktop.ps1 should point at official AGY bootstrapper',
  );
  assert.doesNotMatch(
    windowsBuildScript,
    /@google\/gemini-cli/,
    'build-desktop.ps1 must not pack Gemini CLI as the AGY replacement',
  );
  // macOS build should not reference CLI packaging at all
  assert.doesNotMatch(macBuildScript, /@google\/gemini-cli/, 'build-mac.sh must not pack Gemini CLI');

  // CLI provisioning was removed from the installer (bundled Node has no
  // global npm, so `npm install -g` always fails on clean Windows machines).
  // Verify no Gemini CLI references leaked in.
  assert.doesNotMatch(postInstallScript, /@google\/gemini-cli/);
  assert.doesNotMatch(installerScript, /cli_gemini/);
});
