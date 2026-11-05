import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveWindowsSpawnPlan } from '../../../../utils/cli-spawn-win.js';

const exec = promisify(execFile);

/** Runs only after the owner selects Install, never during repository discovery. */
export async function prepareMarketplaceDirectory(directory: string, root: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name)) {
    throw new Error('Invalid marketplace package name');
  }
  const options = {
    cwd: root,
    env: { ...process.env, CI: 'true' },
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };
  // This is the repository's existing pnpm workspace preparation. In particular,
  // its postinstall restores retained SDK graphs before directory admission.
  const run = async (args: string[]) => {
    if (process.platform === 'win32') {
      const plan = resolveWindowsSpawnPlan('pnpm', args);
      await exec(plan.command, plan.args, { ...options, ...(plan.shell ? { shell: plan.shell } : {}) });
    } else await exec('pnpm', args, options);
  };
  await run(['install', '--frozen-lockfile']);
  if (pkg.scripts?.build) await run(['--filter', `${pkg.name}...`, 'build']);
}
