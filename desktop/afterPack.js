// afterPack.js — Copies node_modules into extraResources after electron-builder
// packs the app. electron-builder intentionally skips directories named
// "node_modules" in extraResources (since v20.15.2), so we do it manually.
// See: https://github.com/electron-userland/electron-builder/issues/3104

const path = require('path');
const fs = require('fs');

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
};
