import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import {
  resolveAcpBootstrap,
  verifyAcpBootstrap,
} from '../domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-context.js';
import { CLI_PROCESS_OWNER_ENV } from '../utils/cli-process-environment.js';
import { resolveCliCommandOrBare } from '../utils/cli-resolve.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { resolveDshDesktopLauncher } from '../utils/dsh-desktop-launcher.js';
import { createDshDumpSnapshot } from './dsh-setup-snapshot.js';
import { resolveDshHome } from './native-dsh-home.js';
import { dshProfileState } from './native-dsh-profile.js';
import { closeCatalogProcess } from './runtime-catalog-process.js';

export interface DshSetupLaunch {
  command: string;
  args: string[];
  cwd: string;
  profileIndex: number;
}

/** Unknown wrappers can change HOME or run arbitrary commands: keep them manual. */
export function resolveDshSetupLaunch(command: string, args: string[], cwd: string): DshSetupLaunch {
  resolveDshHome();
  const desktop = resolveDshDesktopLauncher(command, args);
  const plan = desktop
    ? { command, args }
    : process.platform === 'win32'
      ? resolveWindowsSpawnPlan(command, args)
      : { command, args };
  if ('shell' in plan && plan.shell) throw Error('dsh_setup_custom_startup');
  let offset = 0;
  if (/^node(?:\.exe)?$/i.test(basename(plan.command))) {
    const entry = plan.args[0];
    if (!entry || !isAbsolute(entry) || !/(?:lib[/\\]bin\.js|src[/\\]bin\.ts)$/.test(entry))
      throw Error('dsh_setup_custom_startup');
    assertDshEntry(entry);
    offset = 1;
  } else if (!desktop && (process.platform === 'win32' || !/^dsh$/i.test(basename(plan.command)))) {
    throw Error('dsh_setup_custom_startup');
  } else if (!desktop) {
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

export function dshSetupBootstrap(launch: DshSetupLaunch) {
  return verifyAcpBootstrap(
    resolveAcpBootstrap(
      launch.cwd,
      'dsh-setup',
      {
        command: launch.command,
        startupArgs: launch.args,
      },
      '',
    ),
    'dsh-setup',
  );
}

/** Boot-free DSH composition. No stdout/stderr is returned in errors or logs. */
export async function dumpDshConfig(launch: DshSetupLaunch): Promise<string> {
  // Classify the actual diagnostic arguments. --dump-config is outside the
  // narrow audited startup whitelist, so it uses the normal strict fallback.
  const target = dshSetupBootstrap({ ...launch, args: [...launch.args, '--dump-config'] });
  const snapshot = createDshDumpSnapshot(target.verifyCwd(), launch.args[launch.profileIndex] ?? '');
  try {
    return await runDump(target, snapshot.directory).then((output) => {
      snapshot.verify();
      return output;
    });
  } finally {
    snapshot.dispose();
  }
}
async function runDump(target: ReturnType<typeof dshSetupBootstrap>, home: string): Promise<string> {
  const owner = randomUUID();
  const plan =
    process.platform === 'win32'
      ? resolveWindowsSpawnPlan(target.command, target.args)
      : { command: target.command, args: target.args };
  const child = spawn(plan.command, plan.args, {
    cwd: target.verifyCwd(),
    windowsHide: true,
    shell: 'shell' in plan ? plan.shell : false,
    detached: process.platform !== 'win32',
    env: {
      ...buildChildEnv(undefined, { workingDirectory: target.cwd }),
      ...('env' in plan ? plan.env : {}),
      DSH_HOME: home,
      [CLI_PROCESS_OWNER_ENV]: owner,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    size = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  try {
    return await new Promise<string>((accept, reject) => {
      const deadline = setTimeout(() => reject(Error('dsh_setup_dump_failed')), 20_000);
      child.once('error', () => {
        clearTimeout(deadline);
        reject(Error('dsh_setup_dump_failed'));
      });
      child.stdout.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 4_000_000) reject(Error('dsh_setup_dump_failed'));
        else output += chunk;
      });
      child.once('close', (code) => {
        clearTimeout(deadline);
        if (code === 0 && size <= 4_000_000) accept(output);
        else reject(Error('dsh_setup_dump_failed'));
      });
    });
  } finally {
    await closeCatalogProcess(child, owner);
  }
}
