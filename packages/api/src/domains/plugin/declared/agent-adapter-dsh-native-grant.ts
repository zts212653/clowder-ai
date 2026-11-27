import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { AgentAdapterNativeRuntime } from '@clowder-ai/agent-contract';
import { resolveInvokeCapabilityRoot } from '../../../config/capabilities/invoke-capability-root.js';
import { DSH_CHECK_GUARD, readDshCheckBinding } from '../../../routes/dsh-check-launch.js';
import { dshDesktopL0Compatibility, resolveDshDesktopLaunch } from '../../../utils/dsh-desktop-launch.js';
import { AcpClient } from '../../cats/services/agents/providers/acp/AcpClient.js';
import { resolveAcpBootstrapCwd } from '../../cats/services/agents/providers/acp/acp-bootstrap-cwd.js';
import type { AgentServiceOptions } from '../../cats/services/types.js';
import type { AgentAdapterRuntimeGrant } from './agent-adapter-access.js';
import { createAgentAdapterAcpRuntime } from './agent-adapter-acp-runtime.js';

type Acp = NonNullable<AgentAdapterNativeRuntime['acp']>;
type SavedLaunch = NonNullable<AgentServiceOptions['registeredAcpLaunch']>;
type SessionLaunch = {
  catId: string;
  cwd: string;
  instructions: string;
  saved: SavedLaunch;
  packageRoot: string;
};
const activations = new WeakMap<AbortSignal, { acp: Acp; launches: Map<string, SessionLaunch> }>();

async function createDesktopClient(
  launch: SessionLaunch,
  startup: Parameters<Acp['open']>[0]['startup'],
  signal: AbortSignal,
) {
  const { config, environment, projectRoot } = launch.saved;
  const args = config.startupArgs;
  const desktop = resolveDshDesktopLaunch(config.command, []);
  if (!desktop || !dshDesktopL0Compatibility(config.command, args)?.supported)
    throw new Error('DSH Desktop version or launch is unsupported');

  const home = environment?.DSH_HOME;
  const patch = args[3];
  const directory = join(await resolveInvokeCapabilityRoot(projectRoot), '.cat-cafe', 'dsh-desktop');
  if (
    !home ||
    !isAbsolute(home) ||
    dirname(resolve(home)) !== resolve(directory) ||
    args.length !== 4 ||
    args[2] !== '--patch' ||
    !patch ||
    dirname(resolve(patch)) !== resolve(home) ||
    !(await lstat(home)).isDirectory() ||
    !(await lstat(patch)).isFile() ||
    (await realpath(home)) !== join(await realpath(directory), basename(home))
  )
    throw new Error('DSH Desktop requires a saved managed member configuration');

  const binding = readDshCheckBinding({ command: config.command, args, cwd: projectRoot, env: { DSH_HOME: home } });
  const bridge = binding.patch.flatMap((row) => ('insert' in row ? row.insert : []))[0];
  if (
    !bridge ||
    dirname(fileURLToPath(bridge.name)) !== resolve(directory) ||
    bridge.config.nativeScope !== dirname(dirname(dirname(desktop.args[1])))
  )
    throw new Error('DSH Desktop saved credential bridge is not from the managed setup');

  const module = fileURLToPath(startup.moduleUrl);
  const asset = join(await realpath(launch.packageRoot), 'src', 'dsh-l0-series.mjs');
  const marker = '<!-- clowder-l0:' + createHash('sha256').update(launch.instructions).digest('hex') + ' -->';
  if (
    (await realpath(module)) !== asset ||
    startup.config.body !== launch.instructions ||
    startup.config.marker !== marker
  )
    throw new Error('DSH startup request is outside the Host grant');

  const cwd = await realpath(launch.cwd);
  const boot = () => resolveAcpBootstrapCwd(projectRoot, 'dsh-adapter-' + launch.catId);
  const bootstrap = boot();
  const token = randomUUID();
  const guard = join(bootstrap, 'dsh-tools-' + token + '.mjs');
  const startupPath = join(bootstrap, 'dsh-identity-' + token + '.patch.json');
  const content = JSON.stringify([
    ...binding.patch.map((row) =>
      'id' in row && row.id === 'acp'
        ? { ...row, inject: [...new Set([...(row.inject ?? []), 'clowderConnectionCheckReady'])] }
        : row,
    ),
    {
      insert: [
        { id: 'clowder-dsh-tool-guard', name: pathToFileURL(guard).href },
        { id: 'clowder-l0-series', name: pathToFileURL(asset).href, config: { marker, body: launch.instructions } },
      ],
    },
  ]);
  let client: AcpClient | undefined;
  try {
    await writeFile(guard, DSH_CHECK_GUARD, { flag: 'wx', mode: 0o600 });
    await writeFile(startupPath, content, { flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive', 'OS', 'ProgramFiles']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    client = new AcpClient({
      command: desktop.command,
      args: [],
      cwd: bootstrap,
      stdinShutdownGraceMs: 45_000,
      preparedSpawn: { command: desktop.command, args: [...desktop.args, '--profile', 'acp', '--patch', startupPath] },
      preparedEnv: {
        ...env,
        ...desktop.env,
        DSH_HOME: home,
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        TEMP: home,
        TMP: home,
        DSH_TELEMETRY_DISABLED: '1',
        NO_PROXY: '127.0.0.1,localhost',
      },
      verifyBootstrapCwd() {
        if (boot() !== bootstrap) throw new Error('DSH ACP bootstrap directory changed');
      },
    });
    if ((await readFile(startupPath, 'utf8')) !== content || (await readFile(guard, 'utf8')) !== DSH_CHECK_GUARD)
      throw new Error('DSH ACP startup content changed');
    signal.throwIfAborted();
    await client.initialize();
    signal.throwIfAborted();
    return { client, cwd };
  } catch (error) {
    await client?.close().catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([unlink(startupPath), unlink(guard)]);
  }
}

/** Start only a saved Desktop member under the catalog adapter's activation. */
export const grantAgentAdapterDshDesktop: AgentAdapterRuntimeGrant = (request) => {
  const scope = request.hostSession;
  const catId = request.catId;
  const activation = request.activationSignal;
  if (!scope || !catId || activation.aborted) return;
  const key = JSON.stringify([catId, scope.sessionId]);
  let state = activations.get(activation);
  const action = request.action;
  if (action === 'openSession' || action === 'startTurn') {
    const options = scope.hostOptions;
    const saved = options?.registeredAcpLaunch;
    if (
      !saved ||
      !isAbsolute(scope.cwd) ||
      scope.executionAccount ||
      options.pluginNativeLaunch ||
      options.toolExecutionPolicy ||
      options.boundedWatcher ||
      options.liveCompanion ||
      options.requiredTools?.length ||
      options.cliConfigArgs?.length ||
      options.contentBlocks?.some((block) => block.type !== 'text') ||
      saved.config.transport === 'httpstream'
    )
      return;
    if (!state && action === 'openSession') {
      const launches = new Map<string, SessionLaunch>();
      const acp = createAgentAdapterAcpRuntime(({ hostSessionId, startup }, signal) => {
        const launch = launches.get(hostSessionId);
        if (!launch) throw new Error('DSH ACP launch authorization is unavailable');
        return createDesktopClient(launch, startup, signal);
      }, activation);
      state = { acp, launches };
      activations.set(activation, state);
    }
  }
  if (!state) return;
  const { acp, launches } = state;
  const packageRoot = request.packageRoot;
  return {
    acp: {
      async open(input, signal) {
        const saved = scope.hostOptions?.registeredAcpLaunch;
        if (
          action !== 'openSession' ||
          !saved ||
          !packageRoot ||
          input.hostSessionId !== scope.sessionId ||
          input.resumeNativeSessionId !== scope.resumeNativeSessionId ||
          launches.has(key)
        )
          return { ok: false, code: 'failed' };
        const launch = { saved, cwd: scope.cwd, instructions: scope.instructions, catId, packageRoot };
        launches.set(key, launch);
        let opened = false;
        try {
          const result = await acp.open({ ...input, hostSessionId: key }, signal);
          opened = result.ok;
          return result;
        } finally {
          if (!opened) launches.delete(key);
        }
      },
      async prompt(input, signal) {
        const launch = launches.get(key);
        if (
          action !== 'startTurn' ||
          !launch ||
          input.hostSessionId !== scope.sessionId ||
          input.prompt !== scope.prompt ||
          launch.cwd !== scope.cwd ||
          !isDeepStrictEqual(launch.saved, scope.hostOptions?.registeredAcpLaunch)
        )
          throw new Error('DSH ACP turn is outside the Host grant');
        await scope.hostOptions?.beforeProviderLaunch?.({
          v: 1,
          message: { body: input.prompt },
          nativeInstructions: [{ body: launch.instructions, injectionDecision: 'native_l0_compiled' }],
          runtime: { provider: 'acp', carrier: 'acp', protocol: 'acp' },
          tools: { finalSurface: 'unknown' },
          providerNativeVisibility: 'unknown',
        });
        signal.throwIfAborted();
        return acp.prompt({ hostSessionId: key, prompt: input.prompt }, signal);
      },
      async cancel(hostSessionId) {
        return action === 'cancel' && hostSessionId === scope.sessionId && acp.cancel(key);
      },
      async release(hostSessionId) {
        if ((action !== 'release' && action !== 'openSession') || hostSessionId !== scope.sessionId) return;
        launches.delete(key);
        await acp.release(key);
      },
    },
  };
};
