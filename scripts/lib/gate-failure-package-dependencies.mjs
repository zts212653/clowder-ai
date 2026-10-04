import { execFileSync } from 'node:child_process';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const TEST_LIFECYCLE_SCRIPTS = ['pretest', 'test', 'posttest'];
const INTERNAL_PACKAGE_PREFIX = '@cat-cafe/';

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

function packageManifestPaths(repoRoot, revision) {
  const output = git(repoRoot, ['ls-tree', '-r', '--name-only', revision, '--', 'packages']);
  return output
    .split('\n')
    .filter((filePath) => /^packages\/[^/]+\/package\.json$/.test(filePath))
    .sort();
}

function filteredPackageNames(command) {
  if (typeof command !== 'string') return [];
  return [...command.matchAll(/(?:^|\s)--filter(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((value) => value && !value.startsWith('!'))
    .map((value) => value.replace(/\.\.\.$/, ''));
}

function workspaceDependencies(manifest, packageRootsByName) {
  const dependencies = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!String(version).startsWith('workspace:')) continue;
      const target = packageRootsByName.get(name);
      if (!target) throw new Error(`workspace dependency ${name} has no tracked package manifest`);
      dependencies.push(target);
    }
  }
  return dependencies;
}

function testFilterDependencies(manifest, packageRootsByName) {
  const dependencies = [];
  for (const scriptName of TEST_LIFECYCLE_SCRIPTS) {
    for (const name of filteredPackageNames(manifest.scripts?.[scriptName])) {
      const target = packageRootsByName.get(name);
      if (target) dependencies.push(target);
      else if (name.startsWith(INTERNAL_PACKAGE_PREFIX)) {
        throw new Error(`test filter ${name} has no tracked package manifest`);
      }
    }
  }
  return dependencies;
}

function directDependencies(manifest, packageRootsByName) {
  return new Set([
    ...workspaceDependencies(manifest, packageRootsByName),
    ...testFilterDependencies(manifest, packageRootsByName),
  ]);
}

export function readPackageDependencyClosure(repoRoot, revision = 'HEAD') {
  try {
    const manifests = packageManifestPaths(repoRoot, revision).map((filePath) => ({
      filePath,
      root: filePath.slice(0, -'/package.json'.length),
      manifest: JSON.parse(git(repoRoot, ['show', `${revision}:${filePath}`])),
    }));
    const packageRootsByName = new Map();
    for (const { root, manifest } of manifests) {
      if (typeof manifest.name !== 'string' || packageRootsByName.has(manifest.name)) return null;
      packageRootsByName.set(manifest.name, root);
    }
    const directByRoot = new Map(
      manifests.map(({ root, manifest }) => [root, directDependencies(manifest, packageRootsByName)]),
    );
    const closure = {};
    for (const root of [...directByRoot.keys()].sort()) {
      const reachable = new Set();
      const pending = [...directByRoot.get(root)];
      while (pending.length > 0) {
        const dependency = pending.pop();
        if (!dependency || dependency === root || reachable.has(dependency)) continue;
        const next = directByRoot.get(dependency);
        if (!next) return null;
        reachable.add(dependency);
        pending.push(...next);
      }
      closure[root] = [...reachable].sort();
    }
    return closure;
  } catch {
    return null;
  }
}
