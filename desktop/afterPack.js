// afterPack.js — Copies node_modules into extraResources after electron-builder
// packs the app. electron-builder intentionally skips directories named
// "node_modules" in extraResources (since v20.15.2), so we do it manually.
// See: https://github.com/electron-userland/electron-builder/issues/3104

const path = require('node:path');
const fs = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDir = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
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
