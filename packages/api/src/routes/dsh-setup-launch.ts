import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DshSetupLaunch } from '@clowder-ai/agent-access/discovery/dsh-setup-launch';
import {
  resolveAcpBootstrap,
  verifyAcpBootstrap,
} from '../domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-context.js';
import { CLI_PROCESS_OWNER_ENV } from '../utils/cli-process-environment.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { createDshDumpSnapshot } from './dsh-setup-snapshot.js';
import { closeCatalogProcess } from './runtime-catalog-process.js';

export { type DshSetupLaunch, resolveDshSetupLaunch } from '@clowder-ai/agent-access/discovery/dsh-setup-launch';

export function dshSetupBootstrap(launch: Pick<DshSetupLaunch, 'command' | 'args' | 'cwd' | 'env'>) {
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
    undefined,
    launch.env,
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
