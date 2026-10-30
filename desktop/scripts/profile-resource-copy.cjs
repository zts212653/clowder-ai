const fs = require('node:fs');
const path = require('node:path');

function copyProfileResource(sourceRoot, resource, destination) {
  const boundary = fs.realpathSync(sourceRoot);
  const entries = [];
  const identity = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  function visit(source, relative, ancestors) {
    const actual = fs.realpathSync(source);
    const fromRoot = path.relative(boundary, actual);
    if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`))
      throw new Error(`Outside profile source root: ${source}`);
    const stat = fs.lstatSync(actual);
    if (stat.isDirectory()) {
      if (ancestors.has(identity(actual))) throw new Error(`Cyclic profile resource link: ${source}`);
      entries.push({ source: actual, relative, directory: true });
      const next = new Set([...ancestors, identity(actual)]);
      for (const name of fs.readdirSync(actual).sort()) visit(path.join(actual, name), path.join(relative, name), next);
    } else if (stat.isFile()) entries.push({ source: actual, relative, directory: false });
    else throw new Error(`Unsupported profile resource: ${source}`);
  }
  // Validate the whole source graph before writing. Output is constructed only
  // with mkdir/copyFile, independent of cpSync's platform link semantics.
  visit(path.join(boundary, resource), '', new Set());
  for (const entry of entries) {
    const output = path.join(destination, entry.relative);
    if (entry.directory) fs.mkdirSync(output);
    else fs.copyFileSync(entry.source, output, fs.constants.COPYFILE_EXCL);
  }
}

module.exports = { copyProfileResource };
