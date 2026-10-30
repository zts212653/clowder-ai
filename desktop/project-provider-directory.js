const fs = require('node:fs');
const path = require('node:path');

/** Seed mutable provider configuration, preserving links as configuration entries. */
function seedProviderDirectory({ source, destination, previousLink, removeLink, log }) {
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.cat-cafe-provider-'));
  let removedLink = false;
  try {
    // Source checkouts include managed skill aliases, including dangling links.
    // Do not expand them into immutable resources or read their external targets.
    fs.cpSync(source, stage, { recursive: true, dereference: false, verbatimSymlinks: true });
    if (previousLink !== undefined) {
      removeLink(destination); // The caller has verified this installation mirror.
      removedLink = true;
    }
    try {
      fs.renameSync(stage, destination);
    } catch (error) {
      if (removedLink && !fs.lstatSync(destination, { throwIfNoEntry: false })) {
        fs.symlinkSync(previousLink, destination, process.platform === 'win32' ? 'junction' : 'dir');
      }
      throw error;
    }
    log(`Initialized writable owner provider directory: ${destination}`);
  } finally {
    // Only this call's fresh staging directory; rm never follows its copied links.
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { seedProviderDirectory };
