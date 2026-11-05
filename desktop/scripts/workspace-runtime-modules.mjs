import fs from 'node:fs';
import path from 'node:path';

function packageNames(modules) {
  return fs.readdirSync(modules).flatMap((name) => {
    if (name.startsWith('.')) return [];
    return name.startsWith('@') ? fs.readdirSync(path.join(modules, name)).map((child) => `${name}/${child}`) : [name];
  });
}

/** Hoist identical workspace identities, never merely matching names or versions. */
export function workspaceRuntimeModules(workspace, packages) {
  // pnpm-workspace.yaml registers packages/*; a nested node_modules target
  // is a private dependency, even when its path starts with packages/.
  const packageRoot = path.join(workspace, 'packages');
  const roots = new Set(
    fs
      .readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => fs.realpathSync(path.join(packageRoot, entry.name))),
  );
  const candidates = new Map();
  const visited = new Set();
  const pending = [
    path.join(workspace, 'node_modules'),
    ...packages.map((name) => path.join(workspace, 'packages', name, 'node_modules')),
  ];
  const add = (name, from) => {
    if (!fs.lstatSync(from).isSymbolicLink()) return;
    const real = fs.realpathSync(from);
    if (!roots.has(real)) return;
    const manifest = path.join(real, 'package.json');
    if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== name) return;
    const values = candidates.get(name) ?? new Set();
    values.add(real);
    candidates.set(name, values);
    pending.push(path.join(real, 'node_modules'));
  };
  while (pending.length) {
    const modules = pending.pop();
    if (visited.has(modules) || !fs.existsSync(modules)) continue;
    visited.add(modules);
    for (const name of packageNames(modules)) add(name, path.join(modules, name));
  }
  const hoisted = new Map(
    [...candidates]
      .filter(([name, values]) => {
        if (values.size !== 1) return false;
        const root = path.join(workspace, 'node_modules', name);
        return !fs.existsSync(root) || fs.realpathSync(root) === [...values][0];
      })
      .map(([name, values]) => [name, [...values][0]]),
  );
  const include = (file) => {
    const parent = path.dirname(file);
    const name =
      path.basename(parent).startsWith('@') && path.basename(path.dirname(parent)) === 'node_modules'
        ? `${path.basename(parent)}/${path.basename(file)}`
        : path.basename(parent) === 'node_modules'
          ? path.basename(file)
          : null;
    const target = hoisted.get(name);
    return !target || !fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== target;
  };
  return { hoisted, include };
}
