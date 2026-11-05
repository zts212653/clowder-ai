// afterPack.js — Copies node_modules into extraResources after electron-builder
// packs the app. electron-builder intentionally skips directories named
// "node_modules" in extraResources (since v20.15.2), so we do it manually.
// See: https://github.com/electron-userland/electron-builder/issues/3104

const path = require('node:path');
const fs = require('node:fs');

/** Walk main.js's top-level `require('./x')` graph exactly like the packaging contract test. */
function collectMainProcessLocalRequires(desktopDir, entry = 'main.js') {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const relativeSourcePath = pending.shift();
    if (visited.has(relativeSourcePath)) continue;
    visited.add(relativeSourcePath);
    const source = fs.readFileSync(path.join(desktopDir, relativeSourcePath), 'utf8');
    for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let dependencyPath = path.relative(
        desktopDir,
        path.resolve(desktopDir, path.dirname(relativeSourcePath), match[1]),
      );
      if (!path.extname(dependencyPath)) dependencyPath += '.js';
      dependencyPath = dependencyPath.split(path.sep).join('/');
      if (path.extname(dependencyPath) !== '.js') continue;
      pending.push(dependencyPath);
    }
  }
  return [...visited];
}

function normalizeArchiveEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

/** Fail the Windows package when a runtime module main.js needs is absent from app.asar. */
function verifyWindowsMainProcessClosure(appOutDir) {
  const desktopDir = __dirname;
  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const packagedFileSpecs = new Set(packageJson.build?.files ?? []);
  const closure = collectMainProcessLocalRequires(desktopDir);
  const missingFromBuildFiles = closure.filter((file) => !packagedFileSpecs.has(file));
  if (missingFromBuildFiles.length > 0) {
    throw new Error(
      `afterPack: desktop/package.json build.files is missing main-process modules: ${missingFromBuildFiles.join(', ')}`,
    );
  }
  const asarPath = path.join(appOutDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.warn(`  afterPack: ${asarPath} not found, skipping main-process closure check`);
    return;
  }
  const { listPackage } = require('@electron/asar');
  const packagedEntries = new Set(listPackage(asarPath).map(normalizeArchiveEntry));
  const missingFromArchive = closure.filter((file) => !packagedEntries.has(file));
  if (missingFromArchive.length > 0) {
    throw new Error(`afterPack: Windows app.asar is missing main-process modules: ${missingFromArchive.join(', ')}`);
  }
  console.log(`  afterPack: verified ${closure.length} main-process modules inside app.asar`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    verifyWindowsMainProcessClosure(context.appOutDir);
    return;
  }
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDir = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  require('./scripts/build-app-assist.cjs').buildAppAssist(
    path.join(resourcesDir, 'app', 'plugin-window', 'native', 'app-assist'),
    context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : 'unsupported',
  );
  const projectRoot = path.resolve(__dirname, '..');
  const deployRoot = path.join(projectRoot, 'bundled', 'deploy');

  const packages = ['api', 'web', 'mcp-server'];
  for (const pkg of packages) {
    const src = path.join(deployRoot, pkg, 'node_modules');
    const dest = path.join(resourcesDir, 'packages', pkg, 'node_modules');
    if (fs.existsSync(src)) {
      console.log(`  afterPack: copying ${pkg}/node_modules ...`);
      fs.cpSync(src, dest, { recursive: true });
      console.log(`  afterPack: ${pkg}/node_modules copied`);
    } else {
      console.warn(`  afterPack: ${src} not found, skipping`);
    }
  }

  // scripts/ is copied as an extraResource but has no node_modules.
  // compile-system-prompt-l0.mjs imports @cat-cafe/shared (ESM), and
  // Node's ESM resolver ignores NODE_PATH — it only walks the filesystem
  // node_modules chain. Create a relative symlink so the resolver finds
  // packages from the api deployment.
  const scriptsNM = path.join(resourcesDir, 'scripts', 'node_modules');
  const apiNM = path.join(resourcesDir, 'packages', 'api', 'node_modules');
  if (!fs.existsSync(scriptsNM) && fs.existsSync(apiNM)) {
    // Relative symlink: scripts/node_modules → ../packages/api/node_modules
    fs.symlinkSync(path.relative(path.dirname(scriptsNM), apiNM), scriptsNM);
    console.log('  afterPack: scripts/node_modules → packages/api/node_modules (symlink)');
  }
};
