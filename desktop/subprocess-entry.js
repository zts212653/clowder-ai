const path = require('node:path');

function resolveExternalNodeEntry(entryName, appDir = __dirname) {
  const resolvedAppDir = path.resolve(appDir);
  const runtimeDir =
    path.extname(resolvedAppDir).toLowerCase() === '.asar' ? `${resolvedAppDir}.unpacked` : resolvedAppDir;

  return path.join(runtimeDir, entryName);
}

module.exports = { resolveExternalNodeEntry };
