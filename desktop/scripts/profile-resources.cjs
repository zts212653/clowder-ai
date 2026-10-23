const fs = require('node:fs');
const path = require('node:path');
const { readTree, sameTree } = require('../project-resource-tree.js');

function copyProfileResources(sourceRoot, app) {
  const boundary = fs.realpathSync(sourceRoot);
  for (const name of ['assets', 'docs', 'guides', 'cat-cafe-skills']) {
    const source = path.join(sourceRoot, name);
    const destination = path.join(app, name);
    // Build profiles must model the physical installer layout. Do not depend
    // on cpSync's platform/version-specific recursive symlink dereferencing.
    fs.mkdirSync(destination);
    const entries = readTree(source, {
      boundary,
      onFile: (relative, data) => {
        const file = path.join(destination, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data, { flag: 'wx' });
      },
    });
    for (const [relative, kind] of entries)
      if (relative && kind === 'directory') fs.mkdirSync(path.join(destination, relative), { recursive: true });
    if (!sameTree(entries, readTree(destination))) throw new Error(`Profile resource copy differs: ${source}`);
  }
}

module.exports = { copyProfileResources };
