// Preloaded into the smoke process, its workers and forked native helpers.
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath } = require('node:url');

const root = path.join(fs.realpathSync(process.env.CLOWDER_NATIVE_SMOKE_ROOT), 'node_modules');
if (fs.realpathSync(root) !== root) throw new Error(`Deployed node_modules is an external symlink: ${root}`);
const violations = [];
const nativeFiles = new Set();
const before = new Set(process.report.getReport().sharedObjects);

function within(file, directory) {
  // Windows dlopen receives \\?\ paths even when the deployment root uses
  // ordinary drive/UNC spelling. Compare both in Node's namespace form;
  // realpath still resolves symlinks before artifact containment is checked.
  const relative = path.relative(path.toNamespacedPath(directory), path.toNamespacedPath(file));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function artifactPath(file) {
  const resolved = fs.realpathSync(file);
  if (!within(resolved, root)) {
    const message = `Native artifact dependency escapes deployed node_modules: ${resolved}`;
    violations.push(message);
    throw new Error(message);
  }
  return resolved;
}

function checkURL(url) {
  if (url.startsWith('node:')) return;
  artifactPath(fileURLToPath(url));
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    checkURL(result.url);
    return result;
  },
  load(url, context, nextLoad) {
    checkURL(url);
    return nextLoad(url, context);
  },
});

const dlopen = process.dlopen;
process.dlopen = function (module, filename, ...args) {
  nativeFiles.add(artifactPath(filename));
  return dlopen.call(this, module, filename, ...args);
};

const systemDirs =
  process.platform === 'win32'
    ? [path.join(process.env.SystemRoot, 'System32')]
    : ['/usr/lib', '/lib', '/System/Library', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib'];

globalThis.clowderNativeArtifactAudit = {
  artifactPath,
  assertComplete() {
    // Also check libraries loaded by SQLite/dlopen's OS linker, not only .node
    // entry files. Existing Node runtime libraries and OS libraries are allowed.
    for (const file of process.report.getReport().sharedObjects) {
      if (!before.has(file) && !systemDirs.some((directory) => within(file, directory)))
        nativeFiles.add(artifactPath(file));
    }
    // Dependency loaders sometimes catch native/optional import errors. An
    // attempted escape must not become a successful fallback smoke result.
    if (violations.length) throw new Error(violations.join('\n'));
    console.log('native-artifact paths:', JSON.stringify([...nativeFiles]));
  },
};
