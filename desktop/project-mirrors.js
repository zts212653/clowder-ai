const fs = require('node:fs');
const path = require('node:path');
const { PHYSICAL_RESOURCES, materializeResource } = require('./project-resource-materialization');

const PROJECT_MIRRORS = Object.freeze([
  '.claude',
  'assets',
  'cat-cafe-skills',
  'docs',
  'guides',
  'packages',
  'plugins',
  'scripts',
]);
const PROJECT_MIRROR_PROBES = Object.freeze(
  [
    { mirror: 'docs', relativePath: path.join('harness-feedback', 'eval-domains', 'eval-design-gate.yaml') },
    { mirror: 'cat-cafe-skills', relativePath: path.join('refs', 'shared-rules.md') },
    { mirror: 'cat-cafe-skills', relativePath: path.join('custody-recognition', 'SKILL.md') },
  ].map(Object.freeze),
);

function describeFilesystemError(error) {
  return `code=${error.code ?? 'unknown'} errno=${error.errno ?? 'unknown'} syscall=${error.syscall ?? 'unknown'}: ${error.message}`;
}

function sameTarget(first, second) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(first) === normalize(second);
}

/** Remove only a verified link entry, never its target or a real directory. */
function removeMirrorLink(destination) {
  fs.readlinkSync(destination);
  if (process.platform === 'win32') {
    try {
      fs.rmdirSync(destination);
      return;
    } catch (error) {
      if (!fs.lstatSync(destination).isSymbolicLink()) throw error;
    }
  }
  fs.unlinkSync(destination);
}

function prepareMirrorEntry({ source, destination, rebuild, log }) {
  let existing;
  try {
    existing = fs.lstatSync(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    let target;
    try {
      target = fs.readlinkSync(destination);
    } catch (error) {
      // An unreadable entry is never sufficient authority to remove it.
      log(`Preserving existing non-link mirror ${destination}: ${describeFilesystemError(error)}`);
      return;
    }
    const absoluteTarget = path.resolve(path.dirname(destination), target);
    if (sameTarget(absoluteTarget, source) && !rebuild) return;
    removeMirrorLink(destination);
    log(`Removed mirror link ${destination} (was -> ${target})`);
  }
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  log(`Mirror link created: ${destination} -> ${source}`);
}

function preparePhysicalResource(options, rebuild) {
  const { destination } = options;
  // A second read/copy cannot repair a transient reader failure in an already
  // physical directory. Leave it for the actual consumer probe.
  if (rebuild.size) {
    try {
      if (!fs.lstatSync(destination).isSymbolicLink()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    materializeResource({ ...options, removeLink: removeMirrorLink });
  } catch (error) {
    options.log(
      `Bundled resource preparation failed: ${options.source} -> ${destination}: ${describeFilesystemError(error)}`,
    );
    throw error;
  }
}

/** Prepare physical Windows resources and optional links; preserve owner data. */
function prepareProjectMirrors({
  installRoot,
  projectDir,
  log = () => {},
  rebuildMirrors = [],
  platform = process.platform,
}) {
  const rebuild = new Set(rebuildMirrors);
  fs.mkdirSync(projectDir, { recursive: true });
  for (const mirror of PROJECT_MIRRORS) {
    if (rebuild.size && !rebuild.has(mirror)) continue;
    const source = path.join(installRoot, mirror);
    const destination = path.join(projectDir, mirror);
    try {
      if (!fs.statSync(source).isDirectory()) throw new Error('Bundled mirror source is not a directory');
    } catch (error) {
      log(`Skipping mirror source ${source}: ${describeFilesystemError(error)}`);
      continue;
    }
    if (platform === 'win32' && PHYSICAL_RESOURCES.has(mirror)) {
      // Failure is fatal: a readable probe must not hide an incomplete copy or
      // overwrite a modified resource. Readiness still performs its full reads.
      preparePhysicalResource({ source, destination, installRoot, mirror, log }, rebuild);
      continue;
    }
    try {
      prepareMirrorEntry({ source, destination, rebuild: rebuild.has(mirror), log });
    } catch (error) {
      log(`Warning: failed to prepare mirror ${destination} from ${source}: ${describeFilesystemError(error)}`);
    }
  }
}

module.exports = { PROJECT_MIRRORS, PROJECT_MIRROR_PROBES, describeFilesystemError, prepareProjectMirrors };
