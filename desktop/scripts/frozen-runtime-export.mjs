import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { selectRuntimeDependencies } from './runtime-dependency-selection.mjs';
import { stageBuiltWeb } from './stage-built-web.mjs';
import { workspaceRuntimeModules } from './workspace-runtime-modules.mjs';

const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Materialize only links inside the frozen workspace; reject external/cyclic inputs. */
export function materialize(from, to, workspace, ancestors = new Set(), include = () => true) {
  if (!include(from)) return;
  const real = !ancestors.size || fs.lstatSync(from).isSymbolicLink() ? fs.realpathSync(from) : path.resolve(from);
  if (!inside(workspace, real)) throw new Error(`External packaging link: ${from}`);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    fs.copyFileSync(real, to);
    return;
  }
  if (ancestors.has(real)) throw new Error(`Cyclic packaging link: ${from}`);
  const next = new Set(ancestors).add(real);
  const manifest = path.join(real, 'package.json');
  const packageName = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).name : undefined;
  // The SDK library drives an explicitly selected external Claude installation.
  // Do not ship its optional native engine, including nested/private copies.
  if (/^@anthropic-ai\/claude-agent-sdk-(?:win32|darwin|linux)-/.test(packageName ?? '')) return;
  fs.mkdirSync(to, { recursive: true });
  const omitSendTests = packageName === '@fastify/send';
  for (const name of fs.readdirSync(real)) {
    // Hoisted layout contains no virtual store; its .bin symlinks are not runtime inputs.
    if (name === '.bin' || name === '.pnpm') continue;
    // Published test fixtures include snowman filenames that crash Windows BSD tar.
    // This package's production entry/exports do not reference its test directory.
    if (omitSendTests && name === 'test') continue;
    materialize(path.join(real, name), path.join(to, name), workspace, next, include);
  }
}

export function exportFrozenRuntime(
  workspace,
  out,
  packages,
  lockFile,
  { sharedDependencies = false, builtWebSource, pruneWebBuildDependencies = false, expectedWebBuildCommit } = {},
) {
  workspace = fs.realpathSync(workspace);
  const lockHash = hash(lockFile);
  if (hash(path.join(workspace, 'pnpm-lock.yaml')) !== lockHash) throw new Error('Frozen workspace lock changed');
  if (fs.existsSync(out)) throw new Error(`Output must be new: ${out}`);
  if (expectedWebBuildCommit !== undefined && packages.includes('api')) {
    const stamp = path.join(workspace, 'packages/api/dist/.build-commit');
    if (
      !/^[a-f0-9]{40}$/.test(expectedWebBuildCommit) ||
      !fs.existsSync(stamp) ||
      fs.readFileSync(stamp, 'utf8').trim() !== expectedWebBuildCommit
    )
      throw new Error('API build identity does not match the release revision; rebuild API and Web together');
  }
  fs.mkdirSync(out, { recursive: true });
  const workspaceModules = sharedDependencies ? workspaceRuntimeModules(workspace, packages) : null;
  const webSelection = pruneWebBuildDependencies
    ? selectRuntimeDependencies(
        workspace,
        builtWebSource ?? path.join(workspace, 'packages/web'),
        expectedWebBuildCommit,
      )
    : null;
  if (webSelection && (!sharedDependencies || !packages.includes('web')))
    throw new Error('Web dependency selection requires a shared Windows Web deployment');
  if (sharedDependencies) {
    const shared = path.join(out, 'dependencies');
    materialize(
      path.join(workspace, 'node_modules'),
      shared,
      workspace,
      new Set(),
      (file) => workspaceModules.include(file) && (!webSelection || webSelection.include(file)),
    );
    for (const [name, source] of workspaceModules.hoisted) {
      const target = path.join(shared, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      materialize(source, target, workspace, new Set(), workspaceModules.include);
    }
    fs.writeFileSync(path.join(shared, '.runtime-lock.json'), JSON.stringify({ lockHash, node: process.version }));
  }
  for (const name of packages) {
    const source = path.join(workspace, 'packages', name);
    const destination = path.join(out, name);
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source)) {
      if (['node_modules', '.next', '.cache'].includes(entry)) continue;
      if (sharedDependencies && (entry === 'test' || (name === 'web' && entry === 'src'))) continue;
      materialize(
        path.join(source, entry),
        path.join(destination, entry),
        workspace,
        new Set(),
        (file) =>
          !sharedDependencies ||
          name !== 'api' ||
          !file.startsWith(path.join(source, 'dist') + path.sep) ||
          !/\.d\.[cm]?ts(?:\.map)?$/.test(file),
      );
    }
    // Retained packages keep their complete private peers and contents. Optional
    // Web selection affects root build-only packages, never these private trees.
    // Workspace links in the hoisted tree become ordinary files within this output.
    const ownModules = path.join(source, 'node_modules');
    const modules = path.join(destination, 'node_modules');
    if (sharedDependencies) {
      fs.mkdirSync(modules);
      if (fs.existsSync(ownModules)) materialize(ownModules, modules, workspace, new Set(), workspaceModules.include);
    } else exportModules(path.join(workspace, 'node_modules'), ownModules, modules, workspace);
    fs.writeFileSync(path.join(destination, '.runtime-lock.json'), JSON.stringify({ lockHash, node: process.version }));
    if (name === 'web' && builtWebSource) stageBuiltWeb(builtWebSource, destination);
  }
  return {
    lockHash,
    packages,
    sharedDependencies,
    ...(webSelection ? { webRuntimeSelection: webSelection.receipt } : {}),
    ...(workspaceModules ? { sharedWorkspacePackages: [...workspaceModules.hoisted.keys()].sort() } : {}),
  };
}

/** A package override replaces the entire module, never overlays old private peers. */
export function exportModules(rootModules, ownModules, destination, workspace) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(rootModules)) {
    if (name.startsWith('.')) continue;
    const source = path.join(rootModules, name);
    if (name.startsWith('@')) {
      fs.mkdirSync(path.join(destination, name), { recursive: true });
      for (const child of fs.readdirSync(source)) {
        if (fs.existsSync(path.join(ownModules, name, child))) continue;
        materialize(path.join(source, child), path.join(destination, name, child), workspace);
      }
    } else if (!fs.existsSync(path.join(ownModules, name))) {
      materialize(source, path.join(destination, name), workspace);
    }
  }
  if (fs.existsSync(ownModules)) materialize(ownModules, destination, workspace);
}
