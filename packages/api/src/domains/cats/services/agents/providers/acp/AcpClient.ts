import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import {
  ACP_CHILD_SHUTDOWN_GRACE_MS,
  type AcpChildConnection,
  type AcpClientConfig,
  buildAcpSpawnLogFields,
  NATIVE_HOME_ENV_KEYS,
  AcpClient as ProtocolAcpClient,
} from '@clowder-ai/agent-access/runtime/acp/AcpClient';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { buildChildEnv } from '../../../../../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import { buildUnixSupervisedSpawnPlan } from '../../../../../../utils/cli-supervised-process.js';
import { shutdownAcpChild } from './lifecycle/acp-child-shutdown.js';

export * from '@clowder-ai/agent-access/runtime/acp/AcpClient';

const log = createModuleLogger('acp-client');
const IS_WINDOWS = process.platform === 'win32';

export function launchAcpChild(config: AcpClientConfig, captureCwdIdentity: () => void) {
  const doSpawn = config.spawnFn ?? nodeSpawn;

  // Mirror cli-spawn.ts on Windows so ACP agents can bypass npm-global .cmd shims.
  // On macOS GUI apps (Electron), resolve bare command names (e.g. 'gemini') to
  // full paths via resolveCliCommandOrBare, then inject the bin directory into
  // PATH so `#!/usr/bin/env node` shims can find the node interpreter.
  const selectedSpawn = config.preparedSpawn ?? {
    command: resolveCliCommandOrBare(config.command),
    args: config.args,
  };
  let { command } = selectedSpawn;
  let args = [...selectedSpawn.args];
  const childEnv = config.preparedEnv
    ? { ...config.preparedEnv }
    : buildChildEnv(config.env, {
        workingDirectory: config.cwd,
        inheritParentEnv: config.inheritParentEnv,
      });
  if (!IS_WINDOWS && isAbsolute(command)) {
    const binDir = dirname(command);
    childEnv.PATH = childEnv.PATH ? `${binDir}:${childEnv.PATH}` : binDir;
  }
  // #712: Re-create bootstrap CWD if it was cleaned up by OS temp-dir rotation
  // or by the ACP agent process on exit. Node.js spawn() returns ENOENT when the
  // cwd doesn't exist, even though the command binary itself exists — the error
  // message misleadingly points at the command path.
  // Skip when a test spawnFn is injected — the directory may be a fake path
  // (e.g. '/my/project') that can't be created on CI runners.
  if (!config.spawnFn && !(IS_WINDOWS && config.verifyBootstrapCwd)) {
    mkdirSync(config.cwd, { recursive: true, mode: 0o700 });
  }
  // #1203: Capture the cwd's directory identity at spawn so isCwdIntact can
  // detect delete→recreate at the same path, not just deletion.

  const spawnOpts: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } = {
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    ...(config.preparedSpawn?.shell !== undefined ? { shell: config.preparedSpawn.shell } : {}),
  };
  if (IS_WINDOWS && !config.spawnFn && !config.preparedSpawn) {
    const spawnPlan = resolveWindowsSpawnPlan(command, args);
    log.debug(
      {
        original: command,
        resolved: spawnPlan.command,
        mode: spawnPlan.mode,
        shell: spawnPlan.shell,
      },
      'ACP: Windows spawn plan resolved',
    );
    command = spawnPlan.command;
    args = spawnPlan.args;
    Object.assign(childEnv, spawnPlan.env);
    if (spawnPlan.shell !== undefined) {
      spawnOpts.shell = spawnPlan.shell;
    }
  }

  const providerCommand = command;
  const providerArgs = args;
  if (!IS_WINDOWS && !config.spawnFn) {
    const supervised = buildUnixSupervisedSpawnPlan(command, args, {
      env: childEnv,
      killGraceMs: Math.max(250, ACP_CHILD_SHUTDOWN_GRACE_MS - 1_000),
    });
    command = supervised.command;
    args = supervised.args;
    spawnOpts.env = supervised.env;
  }

  if (IS_WINDOWS && !config.spawnFn) config.verifyBootstrapCwd?.(command, args, childEnv);
  captureCwdIdentity();
  const child = doSpawn(command, args, spawnOpts);
  const connection: AcpChildConnection = {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    isWritable: () => Boolean(child.stdin?.writable && !child.stdin.destroyed),
    isKilled: () => child.killed,
    write: (line) => {
      child.stdin?.write(line);
    },
    onError: (listener) => {
      child.on('error', listener);
    },
    onExit: (listener) => {
      child.on('exit', listener);
    },
    shutdown: (graceMs, endStdin) => shutdownAcpChild(child, graceMs, endStdin),
  };
  const nativeHomes = Object.fromEntries(NATIVE_HOME_ENV_KEYS.map((key) => [key, childEnv[key]]));
  return {
    child: connection,
    writeLine: (line: string) =>
      new Promise<void>((resolve, reject) => {
        if (!child.stdin || child.stdin.destroyed) {
          reject(new Error('ACP agent stdin is not writable'));
          return;
        }
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
      }),
    childEnv: nativeHomes,
    spawnLog: buildAcpSpawnLogFields({
      command: providerCommand,
      args: providerArgs,
      cwd: config.cwd,
      pid: child.pid,
      env: config.env,
    }),
  };
}

export class AcpClient extends ProtocolAcpClient {
  constructor(config: AcpClientConfig) {
    super(config, { launch: launchAcpChild, log });
  }
}
