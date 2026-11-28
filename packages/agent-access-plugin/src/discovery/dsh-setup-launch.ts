import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { resolveCliCommandOrBare } from '../workstation/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../workstation/cli-spawn-win.js';
import { resolveDshDesktopLaunch } from '../workstation/dsh-desktop-launch.js';
import { resolveDshHome } from './native-dsh-home.js';
import { dshProfileState } from './native-dsh-profile.js';

export interface DshSetupLaunch {
  command: string;
  args: string[];
  cwd: string;
  profileIndex: number;
  env?: Record<string, string>;
}

/** Unknown wrappers can change HOME or run arbitrary commands: keep them manual. */
export function resolveDshSetupLaunch(command: string, args: string[], cwd: string): DshSetupLaunch {
  resolveDshHome();
  const desktop = process.platform === 'win32' && resolveDshDesktopLaunch(resolveCliCommandOrBare(command), args);
  const plan = desktop
    ? { command, args }
    : process.platform === 'win32'
      ? resolveWindowsSpawnPlan(command, args)
      : { command, args };
  if ('shell' in plan && plan.shell) throw Error('dsh_setup_custom_startup');
  let offset = 0;
  if (desktop) {
    // Preserve the registered descriptor; all executions consume the same Desktop spawn plan.
  } else if (/^node(?:\.exe)?$/i.test(basename(plan.command))) {
    const entry = plan.args[0];
    if (!entry || !isAbsolute(entry) || !/(?:lib[/\\]bin\.js|src[/\\]bin\.ts)$/.test(entry))
      throw Error('dsh_setup_custom_startup');
    assertDshEntry(entry);
    offset = 1;
  } else if (process.platform === 'win32' || !/^dsh$/i.test(basename(plan.command))) {
    throw Error('dsh_setup_custom_startup');
  } else {
    assertDshEntry(realpathSync(resolveCliCommandOrBare(plan.command)));
  }
  const rest = plan.args.slice(offset);
  if (rest[0] !== '--profile' || !/^[\w-]+$/.test(rest[1] ?? '')) throw Error('dsh_setup_custom_startup');
  for (let i = 2; i < rest.length; i += 2) {
    if (rest[i] !== '--patch' || !isAbsolute(rest[i + 1] ?? '')) throw Error('dsh_setup_custom_startup');
  }
  const state = dshProfileState(undefined, rest[1]);
  if (state !== 'configured' && !(rest[1] === 'acp' && state === 'acp_profile_missing'))
    throw Error('dsh_setup_profile_required');
  return { command: plan.command, args: [...plan.args], cwd, profileIndex: offset + 1 };
}
function assertDshEntry(entry: string): void {
  if (!/(?:lib[/\\]bin\.js|src[/\\]bin\.ts)$/.test(entry)) throw Error('dsh_setup_custom_startup');
  const pkg = JSON.parse(readFileSync(resolve(dirname(entry), '../package.json'), 'utf8')) as { name?: string };
  if (pkg.name !== '@deepseek-ai/dsh') throw Error('dsh_setup_custom_startup');
}
