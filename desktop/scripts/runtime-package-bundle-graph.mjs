import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const names = new Set(['@cat-cafe/shared', '@clowder-ai/plugin-contract']);
export const fileHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const inside = (root, file) =>
  file === root ||
  (!path.isAbsolute(path.relative(root, file)) &&
    !path.relative(root, file).startsWith(`..${path.sep}`) &&
    path.relative(root, file) !== '..');

function children(modules) {
  return fs.readdirSync(modules, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) return [];
    const file = path.join(modules, entry.name);
    return entry.name.startsWith('@') ? fs.readdirSync(file).map((name) => path.join(file, name)) : [file];
  });
}

function selectPackage(root, folder, selected) {
  const actual = fs.realpathSync(folder);
  if (!inside(root, actual)) throw new Error('Package is outside the frozen output');
  const manifest = path.join(actual, 'package.json');
  if (fs.existsSync(manifest) && names.has(JSON.parse(fs.readFileSync(manifest, 'utf8')).name)) selected.add(actual);
  return path.join(actual, 'node_modules');
}

/** Traverse only module directories, retaining each real root and private island. */
export function runtimePackageRoots(root) {
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'dependencies/.runtime-lock.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/i.test(marker.lockHash ?? '')) throw new Error('Expected materialized frozen dependencies');
  const pending = [
    path.join(root, 'dependencies'),
    ...fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'node_modules')),
  ];
  const visited = new Set(),
    selected = new Set();
  while (pending.length) {
    const modules = pending.pop();
    if (!fs.existsSync(modules)) continue;
    const canonical = fs.realpathSync(modules);
    if (!inside(root, canonical)) throw new Error('Module directory is outside the frozen output');
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    for (const folder of children(canonical)) pending.push(selectPackage(root, folder, selected));
  }
  return [...selected].sort();
}

function exportPath(value, reject) {
  if (typeof value === 'string' && value.endsWith('.json')) return value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((name) => ['import', 'types'].includes(name)) &&
    typeof value.import === 'string' &&
    value.import.startsWith('./dist/') &&
    value.import.endsWith('.js')
  )
    return value.import;
  reject();
}

function containedExport(packageRoot, relative, reject) {
  if (!relative.startsWith('./')) reject();
  const file = path.resolve(packageRoot, relative),
    canonical = fs.realpathSync(file);
  if (!inside(packageRoot, file) || !inside(packageRoot, canonical)) throw new Error('Export is outside its package');
  return { file, canonical };
}

export function runtimePackageExports(packageRoot) {
  const manifestFile = path.join(packageRoot, 'package.json');
  if (!inside(packageRoot, fs.realpathSync(manifestFile))) throw new Error('Manifest is outside its package');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const reject = () => {
    throw new Error(`Unsupported runtime package exports: ${manifest.name}`);
  };
  if (
    manifest.type !== 'module' ||
    !manifest.exports ||
    typeof manifest.exports !== 'object' ||
    Array.isArray(manifest.exports)
  )
    reject();
  const entries = [],
    assets = [],
    targets = new Set();
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (!/^\.(?:\/[\w.-]+)*$/.test(key)) reject();
    const relative = exportPath(value, reject);
    const { file, canonical } = containedExport(packageRoot, relative, reject);
    if (typeof value === 'string') assets.push(file);
    else {
      if (targets.has(canonical)) reject();
      targets.add(canonical);
      entries.push({ key, file });
    }
  }
  if (!entries.some((entry) => entry.key === '.')) reject();
  return { manifest, manifestFile, entries, assets };
}
