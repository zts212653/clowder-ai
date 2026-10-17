import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDesktopApi } from './bundle-desktop-api.mjs';
import { bundleRuntimePackages } from './bundle-runtime-packages.mjs';
import { exportFrozenRuntime } from './frozen-runtime-export.mjs';
import { profileDesktopStartup } from './profile-desktop-startup.mjs';
import { rebuildFrozenDependencies } from './rebuild-frozen-dependencies.mjs';

const args = process.argv.slice(2);
const source = path.resolve(args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const out = path.resolve(args[1] ?? path.join(source, 'bundled/deploy'));
const packages = args.slice(2).length ? args.slice(2) : ['api', 'web', 'mcp-server'];
if (packages.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error('Invalid runtime package');
if (fs.existsSync(out)) throw new Error('Use a new packaging output, preserving previous artifacts');
fs.mkdirSync(path.dirname(out), { recursive: true });
const workspace = fs.mkdtempSync(path.join(path.dirname(out), '.frozen-workspace-'));
for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc', 'tsconfig.base.json'])
  fs.copyFileSync(path.join(source, name), path.join(workspace, name));
// Only tracked source inputs and explicitly built dist outputs enter the artifact.
// A prepared release snapshot may supply the same tracked-file inventory without .git.
const inventoryFile = path.join(source, '.build-input-files.json');
const tracked = fs.existsSync(inventoryFile)
  ? JSON.parse(fs.readFileSync(inventoryFile, 'utf8'))
  : execFileSync('git', ['ls-files', '-z'], { cwd: source }).toString('utf8').split('\0').filter(Boolean);
for (const relative of tracked) {
  if (!/^(packages|scripts)\//.test(relative)) continue;
  const from = path.resolve(source, relative),
    target = path.resolve(workspace, relative);
  if (!from.startsWith(source + path.sep) || !target.startsWith(workspace + path.sep))
    throw new Error('Input path escape');
  if (fs.lstatSync(from).isSymbolicLink()) throw new Error(`Linked source input: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(from, target);
}
for (const name of fs.readdirSync(path.join(source, 'packages'))) {
  const dist = path.join(source, 'packages', name, 'dist');
  if (fs.existsSync(dist)) fs.cpSync(dist, path.join(workspace, 'packages', name, 'dist'), { recursive: true });
}
const command = os.platform() === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (arguments_) =>
  spawnSync(command, arguments_, {
    cwd: workspace,
    stdio: 'inherit',
    shell: os.platform() === 'win32',
    env: { ...process.env, CI: '1', CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1' },
  });
// Workspace prepare hooks need dev compilers; compiled workspace artifacts are supplied by the build.
// Dependency install hooks (native ABI) run without rerunning workspace prepare.
const result = run(['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted', '--ignore-scripts']);
if (result.status !== 0) throw new Error(`Frozen production install failed (${result.status}): ${result.error ?? ''}`);
await rebuildFrozenDependencies(workspace);
const receipt = exportFrozenRuntime(workspace, out, packages, path.join(source, 'pnpm-lock.yaml'), {
  sharedDependencies: os.platform() === 'win32',
  builtWebSource: packages.includes('web') ? path.join(source, 'packages/web') : undefined,
  pruneWebBuildDependencies: os.platform() === 'win32' && packages.includes('web'),
  expectedWebBuildCommit:
    os.platform() === 'win32' && packages.includes('web')
      ? (process.env.CAT_CAFE_BUILD_COMMIT ??
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source }).toString().trim())
      : undefined,
});
if (os.platform() === 'win32' && packages.includes('api')) {
  receipt.runtimePackages = await bundleRuntimePackages(out);
  receipt.desktopApi = await bundleDesktopApi(path.join(out, 'api'));
  if (!receipt.desktopApi.agentHooks) throw new Error('Frozen API requires its dedicated installer hooks bundle');
  receipt.startupReadAhead = await profileDesktopStartup(source, out);
}
fs.writeFileSync(path.join(out, 'frozen-install.json'), JSON.stringify({ ...receipt, workspace }, null, 2));
console.log(JSON.stringify({ out, ...receipt }));
