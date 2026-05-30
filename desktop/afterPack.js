// afterPack.js — Copies node_modules into extraResources after electron-builder
// packs the app. electron-builder intentionally skips directories named
// "node_modules" in extraResources (since v20.15.2), so we do it manually.
// See: https://github.com/electron-userland/electron-builder/issues/3104

const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;

  // Resolve the resources directory where extraResources are placed.
  // macOS: {appOutDir}/{ProductName}.app/Contents/Resources/
  // Windows: {appOutDir}/resources/
  let resourcesDir;
  if (platform === 'darwin') {
    const productFilename = context.packager.appInfo.productFilename;
    resourcesDir = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  } else if (platform === 'win32') {
    resourcesDir = path.join(context.appOutDir, 'resources');
  } else {
    // Linux or unknown — skip for now
    return;
  }

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
