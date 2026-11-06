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

test('api build keeps native copy and packaging behind the selected edition entry', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const { activeProfile } = JSON.parse(
    await readFile(new URL('../../shared/src/deployment-profiles.json', import.meta.url), 'utf8'),
  );
  const buildScript = packageJson.scripts?.build;
  let actualBuildScript;

  assert.equal(typeof buildScript, 'string');
  assert.ok(['home', 'opensource'].includes(activeProfile), 'build contract requires a known edition');
  if (activeProfile === 'home') {
    assert.match(buildScript, /node \.\.\/\.\.\/desktop\/scripts\/build-app-assist\.cjs/);
    assert.match(buildScript, /gate-prepared-artifacts\.mjs run --artifact api -- pnpm run build:actual/);
    actualBuildScript = packageJson.scripts?.['build:actual'];
  } else {
    assert.doesNotMatch(buildScript, /gate-prepared-artifacts/);
    assert.equal(packageJson.scripts?.['build:actual'], undefined);
    actualBuildScript = buildScript;
  }
  assert.equal(typeof actualBuildScript, 'string');
  assert.match(actualBuildScript, /pnpm --dir \.\.\/shared build/);
  assert.doesNotMatch(actualBuildScript, /collective-service|collective-connector/);
  assert.match(actualBuildScript, /node \.\/scripts\/copy-bundled-plugin-packages\.mjs/);
  assert.match(actualBuildScript, /node \.\/scripts\/copy-marketplace-catalog-data\.mjs/);
  assert.doesNotMatch(actualBuildScript, /\bmkdir -p\b/);
  assert.doesNotMatch(actualBuildScript, /\bcp\s+src\/marketplace\/catalog-data/);
});

test('api build compiles every mcp-server workspace dependency before mcp-server', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const mcpPackage = JSON.parse(
    await readFile(path.resolve(import.meta.dirname, '../../mcp-server/package.json'), 'utf8'),
  );
  const { activeProfile } = JSON.parse(
    await readFile(new URL('../../shared/src/deployment-profiles.json', import.meta.url), 'utf8'),
  );
  // Same edition contract as the test above: home keeps the native chain in build:actual,
  // the public export moves it to build.
  const nativeBuild = activeProfile === 'home' ? packageJson.scripts?.['build:actual'] : packageJson.scripts?.build;
  assert.equal(typeof nativeBuild, 'string', 'the selected edition has a native build chain');
  const steps = nativeBuild.split(' && ');
  const position = (dir) => steps.indexOf(`pnpm --dir ../${dir} build`);
  const workspaceDependencies = Object.entries(mcpPackage.dependencies ?? {})
    .filter(([, version]) => String(version).startsWith('workspace:'))
    .map(([name]) => name.replace(/^@cat-cafe\//, ''));

  assert.ok(workspaceDependencies.length > 0, 'mcp-server declares workspace dependencies');
  assert.ok(position('mcp-server') >= 0, 'the native build builds mcp-server');
  for (const dependency of workspaceDependencies) {
    assert.ok(
      position(dependency) >= 0 && position(dependency) < position('mcp-server'),
      `${dependency} must build before mcp-server: a direct mcp-server build can run before workspace deps have dist artifacts`,
    );
  }
  assert.match(
    packageJson.scripts.test,
    /^pnpm run build && /,
    'API tests run only after the native build has built them',
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

test('windows desktop packaging uses frozen export without changing Defender settings', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');
  assert.match(buildScript, /frozen-runtime-deploy\.mjs/);
  assert.doesNotMatch(buildScript, /Add-MpPreference|Remove-MpPreference/);
});

test('desktop packaging retains the previous deployment on a new frozen export', async () => {
  const buildScript = await readFile(desktopBuildScriptPath, 'utf8');
  assert.match(buildScript, /Move-Item -LiteralPath \$deployRoot -Destination/);
  assert.match(buildScript, /deploy-before-/);
  assert.ok(
    buildScript.indexOf('Frozen runtime export failed') < buildScript.indexOf('Move-Item -LiteralPath $deployRoot'),
  );
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

test('desktop build fails closed when source locks do not match', async () => {
  for (const file of [desktopBuildScriptPath, desktopMacBuildScriptPath]) {
    const buildScript = await readFile(file, 'utf8');
    assert.match(buildScript, /pnpm install --frozen-lockfile/);
    assert.match(buildScript, /Frozen dependency installation failed/);
    assert.doesNotMatch(buildScript, /if.*LASTEXITCODE.*pnpm install/);
    assert.doesNotMatch(buildScript, /retrying with pnpm install/);
  }
});

test('desktop release inputs require an executable Corepack beside the bundled Node runtime', async () => {
  const windowsBuildScript = await readFile(desktopBuildScriptPath, 'utf8');
  const macBuildScript = await readFile(desktopMacBuildScriptPath, 'utf8');

  assert.match(windowsBuildScript, /\$corepackCmd = Join-Path \$bundledNode "corepack\.cmd"/);
  assert.match(windowsBuildScript, /Test-Path \$corepackCmd/);
  assert.match(windowsBuildScript, /& \$corepackCmd --version/);
  assert.match(windowsBuildScript, /Corepack executable missing beside bundled Node/);

  assert.match(macBuildScript, /local corepack="\$\{dest\}\/bin\/corepack"/);
  assert.match(macBuildScript, /\[\[ -x "\$corepack" \]\]/);
  assert.match(macBuildScript, /"\$corepack" --version/);
  assert.match(macBuildScript, /Corepack executable missing beside bundled Node/);
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
