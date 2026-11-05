import fs from 'node:fs';
import path from 'node:path';
import { packageSignature } from './runtime-web-inputs.mjs';

export function rootModuleNames(modules) {
  if (!fs.existsSync(modules)) return [];
  return fs.readdirSync(modules, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) return [];
    return entry.name.startsWith('@')
      ? fs.readdirSync(path.join(modules, entry.name)).map((name) => `${entry.name}/${name}`)
      : [entry.name];
  });
}

/**
 * Sharp publishes optional native packages for every supported OS/architecture,
 * and its WASM variants pull @emnapi/* helpers that are also optional per
 * platform. Next's trace can mention packages that are present in the lock
 * graph but are not installed in the current build. A missing optional package
 * cannot be a runtime owner and must not make an otherwise valid frozen export
 * fail. Any package that is actually installed still gets retained through the
 * normal owner matching path above.
 */
function isMissingOptionalTraceInput(name) {
  return (
    name.startsWith('@img/sharp-') ||
    name.startsWith('@img/sharp-libvips-') ||
    name === '@emnapi/runtime' ||
    name === '@emnapi/core' ||
    name === '@emnapi/wasi-threads'
  );
}

/** Ambiguous matches retain every original owner; no package identity is merged. */
export function tracedOwners(workspace, records) {
  const modules = path.join(workspace, 'node_modules');
  const matches = new Map(records.map((record) => [record.signature, new Set()]));
  const packageRoot = path.join(workspace, 'packages');
  const moduleRoots = [
    modules,
    ...fs.readdirSync(packageRoot).map((name) => path.join(packageRoot, name, 'node_modules')),
  ];
  const owners = moduleRoots.flatMap((directory) =>
    rootModuleNames(directory).map((name) => path.join(directory, name)),
  );
  for (const root of owners) {
    const pending = [root],
      seen = new Set();
    while (pending.length) {
      const directory = fs.realpathSync(pending.pop());
      if (!directory.startsWith(workspace + path.sep)) throw new Error('External traced package owner');
      if (seen.has(directory)) continue;
      seen.add(directory);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      matches.get(packageSignature(manifest))?.add(root);
      const nested = path.join(directory, 'node_modules');
      pending.push(...rootModuleNames(nested).map((name) => path.join(nested, name)));
    }
  }
  for (const [signature, owners] of matches) {
    if (owners.size) continue;
    const name = JSON.parse(signature)[0];
    if (isMissingOptionalTraceInput(name)) continue;
    throw new Error(`No frozen owner for traced package: ${name}`);
  }
  return [...new Set([...matches.values()].flatMap((owners) => [...owners]))];
}
