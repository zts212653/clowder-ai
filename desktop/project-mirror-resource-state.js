const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MARKER = '.clowder-bundled-resource.json';
const MIRRORS = new Set(['docs', 'cat-cafe-skills', 'assets', 'guides']);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  const result = path.resolve(value);
  return process.platform === 'win32' ? result.toLowerCase() : result;
};

function check(deadline) {
  if (Date.now() >= deadline)
    throw Object.assign(new Error('Managed resource recovery exceeded its bounded budget'), { code: 'ETIMEDOUT' });
}

function statIdentity(filename) {
  const stat = fs.lstatSync(filename);
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    link: stat.isSymbolicLink(),
    directory: stat.isDirectory(),
  };
}

function inventory(root, { deadline = Infinity, copyTo, excludeMarker = false, ownedPaths } = {}) {
  const records = [];
  let bytes = 0;
  let count = 0;
  let hasOwnerEntries = false;
  function visit(relative) {
    check(deadline);
    const filename = path.join(root, relative);
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error(`Managed resource source contains a reparse entry: ${filename}`);
    const owned = !ownedPaths || !relative || ownedPaths.has(relative);
    if (!owned) hasOwnerEntries = true;
    count += 1;
    if (count > 20000) throw new Error('Managed resource inventory exceeds its bounded entry count');
    if (stat.isDirectory()) {
      if (copyTo && relative) fs.mkdirSync(path.join(copyTo, relative));
      if (relative && owned) records.push({ path: relative, kind: 'directory' });
      for (const name of fs.readdirSync(filename).sort()) {
        if (!relative && excludeMarker && name === MARKER) continue;
        if (name === MARKER) throw new Error(`Reserved resource marker in source: ${filename}`);
        visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      // User-added evaluation output is counted and link-checked, never read,
      // copied or treated as bundled content.
      if (!owned) return;
      bytes += stat.size;
      if (stat.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024)
        throw new Error('Managed resource inventory exceeds its bounded size');
      const content = fs.readFileSync(filename);
      check(deadline);
      if (copyTo) fs.writeFileSync(path.join(copyTo, relative), content, { flag: 'wx', mode: stat.mode & 0o777 });
      records.push({ path: relative, kind: 'file', sha256: hash(content) });
    } else throw new Error(`Unsupported managed resource entry: ${filename}`);
  }
  visit('');
  return { digest: hash(JSON.stringify(records)), records, bytes, hasOwnerEntries };
}

function markerAt(destination) {
  const filename = path.join(destination, MARKER);
  try {
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink())
      throw new Error('Managed resource marker is not a regular file');
    if (fs.lstatSync(filename).size > 4 * 1024 * 1024) throw new Error('Managed resource marker is too large');
    const text = fs.readFileSync(filename, 'utf8');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('Invalid managed resource marker JSON');
    }
    if (
      value.schemaVersion !== 1 ||
      !MIRRORS.has(value.mirror) ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      !Array.isArray(value.records) ||
      value.records.length > 20000 ||
      hash(JSON.stringify(value.records)) !== value.digest
    )
      throw new Error('Invalid managed resource marker');
    return { text, value };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function entryState(destination, source, mirror, deadline = Infinity) {
  const identity = statIdentity(destination);
  if (identity.link) {
    const target = fs.readlinkSync(destination);
    if (canonical(path.resolve(path.dirname(destination), target)) !== canonical(source))
      throw new Error(`Managed resource link target changed: ${destination}`);
    return { identity, target };
  }
  if (!identity.directory) throw new Error(`Preserving existing non-directory resource: ${destination}`);
  const marker = markerAt(destination);
  if (!marker || marker.value.mirror !== mirror)
    throw new Error(`Preserving existing real resource directory without ownership: ${destination}`);
  const actual = inventory(destination, {
    deadline,
    excludeMarker: true,
    ownedPaths: new Set(marker.value.records.map((record) => record.path)),
  });
  if (actual.digest !== marker.value.digest) {
    throw new Error(`Managed resource conflict: owner modified files; preserving ${destination}`);
  }
  return { identity, marker, hasOwnerEntries: actual.hasOwnerEntries };
}

function verifyEntry(destination, source, mirror, expected, deadline) {
  const actual = entryState(destination, source, mirror, deadline);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Managed resource entry changed before publish: ${destination}`);
}

function removeGeneratedTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`Refusing generated-tree cleanup for non-directory: ${root}`);
  for (const name of fs.readdirSync(root)) {
    const filename = path.join(root, name);
    const entry = fs.lstatSync(filename);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing generated-tree cleanup containing a reparse entry: ${filename}`);
    if (entry.isDirectory()) removeGeneratedTree(filename);
    else if (entry.isFile()) fs.unlinkSync(filename);
    else throw new Error(`Refusing generated-tree cleanup of unsupported entry: ${filename}`);
  }
  fs.rmdirSync(root);
}

module.exports = {
  MARKER,
  MIRRORS,
  hash,
  canonical,
  check,
  inventory,
  statIdentity,
  markerAt,
  entryState,
  verifyEntry,
  removeGeneratedTree,
};
