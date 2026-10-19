import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// Clowder AI's pnpm workspace is packages/*. Check its direct workspace:* references
// before install; an absent workspace can otherwise leave a dangling pnpm link.
// Version ranges, aliases and relative workspace specs remain pnpm's responsibility.
function readWorkspacePackages(repoRoot) {
  const paths = ['package.json'];
  const packagesRoot = resolve(repoRoot, 'packages');
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(`packages/${entry.name}/package.json`);
    }
  }

  const packages = [];
  const errors = [];
  for (const path of paths.sort()) {
    const absolute = resolve(repoRoot, path);
    if (!existsSync(absolute)) continue;
    try {
      packages.push({ path, metadata: JSON.parse(readFileSync(absolute, 'utf8')) });
    } catch (error) {
      errors.push(`${path}: invalid workspace package JSON (${error.message})`);
    }
  }
  return { packages, errors };
}

export function publicWorkspaceDependencyErrors(repoRoot) {
  const { packages, errors } = readWorkspacePackages(repoRoot);
  const names = new Set(packages.map(({ metadata }) => metadata?.name).filter((name) => typeof name === 'string'));
  for (const { path, metadata } of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, specifier] of Object.entries(metadata?.[field] ?? {})) {
        if (specifier === 'workspace:*' && !names.has(name)) {
          errors.push(`${path}:${field} -> missing workspace package ${name}`);
        }
      }
    }
  }
  return errors.sort();
}
