const fs = require('fs');
const path = require('path');

function hasApiEntrypoint(rootDir) {
  return fs.existsSync(path.join(rootDir, 'packages', 'api', 'dist', 'index.js'));
}

function hasCompleteRuntime(rootDir) {
  return fs.existsSync(path.join(rootDir, 'packages', 'api', 'node_modules'));
}

function resolveProjectRootFromDir(startDir) {
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    if (hasApiEntrypoint(current) && hasCompleteRuntime(current)) {
      return current;
    }
    const parent = path.resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  // Installed layout fallback: __dirname = {app}/desktop-dist/resources/app
  return path.resolve(startDir, '..', '..', '..');
}

module.exports = {
  hasApiEntrypoint,
  hasCompleteRuntime,
  resolveProjectRootFromDir,
};
