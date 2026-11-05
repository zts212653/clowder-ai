import fs from 'node:fs';
import path from 'node:path';
import { rootModuleNames, tracedOwners } from './runtime-package-owners.mjs';
import { webProductionInputs } from './runtime-web-inputs.mjs';

const packageName = (value) => value.match(/^(@[^/]+\/[^/]+|[^/]+)/)?.[1];
const within = (root, value) => value === root || value.startsWith(root + path.sep);

function resolvePackage(name, from, workspace) {
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error('Invalid runtime dependency name');
  for (let directory = from; within(workspace, directory); directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (directory === workspace) break;
  }
  return null;
}

function dependencies(manifest) {
  const optional = new Map(Object.keys(manifest.dependencies ?? {}).map((name) => [name, false]));
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) optional.set(name, true);
  for (const name of Object.keys(manifest.peerDependencies ?? {}))
    if (!optional.has(name)) optional.set(name, !!manifest.peerDependenciesMeta?.[name]?.optional);
  return optional;
}

function dependencyPaths(directory, workspace) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  return [...dependencies(manifest)]
    .map(([name, mayBeAbsent]) => {
      const dependency = resolvePackage(name, directory, workspace);
      if (!dependency && !mayBeAbsent)
        throw new Error('Unresolved runtime dependency: ' + manifest.name + ' -> ' + name);
      return dependency;
    })
    .filter(Boolean);
}

function serverRoots(workspace) {
  const packages = path.join(workspace, 'packages');
  const roots = fs
    .readdirSync(packages)
    .filter((name) => name !== 'web')
    .map((name) => path.join(packages, name));
  return [workspace, ...roots].filter((directory) => fs.existsSync(path.join(directory, 'package.json')));
}

function dependencyClosure(roots, workspace) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const real = fs.realpathSync(pending.pop());
    if (!within(workspace, real)) throw new Error('External runtime dependency');
    if (visited.has(real)) continue;
    visited.add(real);
    pending.push(...dependencyPaths(real, workspace));
    if (real !== workspace) {
      const privateModules = path.join(real, 'node_modules');
      pending.push(...rootModuleNames(privateModules).map((name) => path.join(privateModules, name)));
    }
  }
  return visited;
}

/** Keep full server packages/peers; use Next's own production traces for Web roots. */
export function selectRuntimeDependencies(workspace, builtWebSource, expectedWebBuildCommit) {
  workspace = fs.realpathSync(workspace);
  const input = webProductionInputs(builtWebSource, expectedWebBuildCommit);
  const roots = [...serverRoots(workspace), ...tracedOwners(workspace, input.packages)];
  const webModules = path.join(workspace, 'packages/web/node_modules');
  roots.push(...rootModuleNames(webModules).map((name) => path.join(webModules, name)));
  for (const name of ['next', ...input.configPackages]) {
    const dependency = resolvePackage(name, path.join(workspace, 'packages/web'), workspace);
    if (!dependency) throw new Error('Unresolved traced Web dependency: ' + name);
    roots.push(dependency);
  }
  const visited = dependencyClosure(roots, workspace);
  const modules = path.join(workspace, 'node_modules');
  const excluded = new Set(
    rootModuleNames(modules).filter((name) => !visited.has(fs.realpathSync(path.join(modules, name)))),
  );
  return {
    receipt: {
      webBuildCommit: expectedWebBuildCommit,
      traceCount: input.traces,
      tracedRootPackages: [...new Set(input.packages.map((record) => record.name))].sort(),
      configurationRootPackages: input.configPackages,
      retainedCanonicalPackages: visited.size,
      excludedRootPackages: [...excluded].sort(),
    },
    include(file) {
      const relative = path.relative(modules, file).replaceAll('\\', '/');
      return relative.startsWith('../') || !excluded.has(packageName(relative));
    },
  };
}
