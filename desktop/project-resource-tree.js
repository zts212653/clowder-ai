const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '.clowder-bundled-resource.json';

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Fully read every file. Only bundled, in-installation symlinks may be expanded. */
function visitDirectory(file, relative, ancestors, context) {
  const canonical = fs.realpathSync(file);
  if (ancestors.has(canonical)) throw new Error(`Cyclic bundled resource: ${file}`);
  context.entries.push([relative, 'directory']);
  const next = new Set([...ancestors, canonical]);
  for (const name of fs.readdirSync(file).sort()) {
    if (!relative && name === MARKER) {
      if (context.ignoreMarker) continue;
      throw new Error(`Reserved bundled resource marker: ${file}`);
    }
    visitTree(path.join(file, name), relative ? `${relative}/${name}` : name, next, context);
  }
}

function visitTree(file, relative, ancestors, context) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync(file);
    if (!context.boundary || !inside(context.boundary, target))
      throw new Error(`Unsafe bundled resource link: ${file}`);
    return visitTree(target, relative, ancestors, context);
  }
  if (stat.isDirectory()) return visitDirectory(file, relative, ancestors, context);
  if (!stat.isFile()) throw new Error(`Unsupported bundled resource: ${file}`);
  if (context.ownedPaths && !context.ownedPaths.has(relative)) {
    context.entries.push([relative, 'owner-file']);
    return;
  }
  const data = fs.readFileSync(file);
  context.entries.push([relative, crypto.createHash('sha256').update(data).digest('hex')]);
  context.onFile?.(relative, data);
}

function readTree(root, options = {}) {
  const entries = [];
  visitTree(root, '', new Set(), { ...options, entries });
  return entries;
}

function sameTree(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function readMarker(root, mirror) {
  const file = path.join(root, MARKER);
  if (!lstat(file)) return undefined;
  if (!lstat(root)?.isDirectory() || lstat(root).isSymbolicLink() || !lstat(file).isFile()) {
    throw new Error(`Unsafe managed resource marker: ${file}`);
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || value.mirror !== mirror || !Array.isArray(value.entries)) {
    throw new Error(`Invalid managed resource marker: ${file}`);
  }
  return value;
}

function assertUnchanged(root, mirror) {
  const marker = readMarker(root, mirror);
  if (!marker || !sameTree(readTree(root, { ignoreMarker: true }), marker.entries)) {
    throw new Error(`Preserving modified or unowned resource directory: ${root}`);
  }
  return marker;
}

function inspectManaged(root, mirror) {
  const marker = readMarker(root, mirror);
  const ownedPaths = new Set(marker.entries.map(([relative]) => relative));
  const actual = readTree(root, { ignoreMarker: true, ownedPaths });
  const values = new Map(actual);
  if (!marker.entries.every(([relative, value]) => values.get(relative) === value)) {
    throw new Error(`Preserving modified bundled resource directory: ${root}`);
  }
  return { marker, hasOwnerEntries: actual.length !== marker.entries.length };
}

function stageTree({ source, stage, mirror, boundary, entries }) {
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ version: 1, mirror, entries }), { flag: 'wx' });
  for (const [relative, kind] of entries) {
    if (relative && kind === 'directory') fs.mkdirSync(path.join(stage, relative), { recursive: true });
  }
  const copied = readTree(source, {
    boundary,
    onFile: (relative, data) => fs.writeFileSync(path.join(stage, relative), data, { flag: 'wx' }),
  });
  if (!sameTree(copied, entries)) throw new Error(`Bundled resource changed during preparation: ${source}`);
  assertUnchanged(stage, mirror);
}

module.exports = { MARKER, lstat, readTree, sameTree, readMarker, assertUnchanged, inspectManaged, stageTree };
