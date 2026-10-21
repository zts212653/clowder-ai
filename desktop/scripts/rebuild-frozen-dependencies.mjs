import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** pnpm 9 hoisted rebuild omits dependency hooks; run locked registry inputs in place. */
export function resolveNpmCli(executable = process.execPath) {
  const candidates = [
    path.join(path.dirname(executable), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const npm = candidates.find((file) => fs.existsSync(file));
  if (!npm) throw new Error('Build Node must include npm for native dependency scripts');
  return npm;
}

export async function rebuildFrozenDependencies(workspace, env = process.env) {
  workspace = fs.realpathSync(workspace);
  const runScript = createRequire(resolveNpmCli())('@npmcli/run-script');
  const visited = new Set();
  const rebuildModules = async (modules) => {
    if (!fs.existsSync(modules)) return;
    for (const entry of fs.readdirSync(modules)) {
      if (entry.startsWith('.')) continue;
      const directory = path.join(modules, entry);
      if (entry.startsWith('@')) {
        for (const name of fs.readdirSync(directory)) await rebuildPackage(path.join(directory, name));
      } else await rebuildPackage(directory);
    }
  };
  const rebuildPackage = async (directory) => {
    const real = fs.realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);
    if (!real.startsWith(path.resolve(workspace) + path.sep)) throw new Error(`External dependency: ${directory}`);
    // Workspace prepare is a build responsibility, not a production dependency install hook.
    if (!real.split(path.sep).includes('node_modules')) return;
    const manifest = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
    await rebuildModules(path.join(real, 'node_modules'));
    for (const phase of ['preinstall', 'install', 'postinstall']) {
      if (!manifest.scripts?.[phase] && !(phase === 'install' && fs.existsSync(path.join(real, 'binding.gyp'))))
        continue;
      console.log(`native install hook: ${manifest.name}@${manifest.version} ${phase}`);
      // Direct lifecycle execution runs each phase once, including implicit binding.gyp installs.
      await runScript({
        event: phase,
        path: real,
        pkg: manifest,
        stdio: 'inherit',
        env,
        ...(env.npm_config_script_shell ? { scriptShell: env.npm_config_script_shell } : {}),
      });
    }
  };
  await rebuildModules(path.join(workspace, 'node_modules'));
  for (const name of fs.readdirSync(path.join(workspace, 'packages')))
    await rebuildModules(path.join(workspace, 'packages', name, 'node_modules'));
}
