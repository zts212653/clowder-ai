import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { parse } from 'smol-toml';
import { getAcpConfig } from '../config/cat-config-loader.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { hasPersistedDshSetup } from './dsh-persisted-setup.js';
import { inspectDshRecommendation } from './dsh-recommendation.js';
import { discoverAdditionalRuntimes } from './native-additional-runtimes.js';
import { nativeClaudeConfiguration } from './native-claude-api-config.js';
import { discoverCodeAgentRuntimes } from './native-codeagent-discovery.js';
import { discoverDshRuntime } from './native-dsh-discovery.js';
import { dshLauncherProfileState } from './native-dsh-profile.js';
import { discoverPiRuntime } from './native-pi-discovery.js';
import { nativeRuntimeReadiness } from './native-runtime-readiness.js';
import { nativeBindingHarness, nativeTool } from './native-tool-catalog.js';

interface DiscoveryOptions {
  home?: string;
  commandFor?: typeof resolveCliCommand;
  intranet?: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function metadata(path: string, toml = false): Record<string, unknown> {
  try {
    const source = readFileSync(path, 'utf8');
    const parsed: unknown = toml ? parse(source) : JSON.parse(source);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
/** Startup descriptors containing credentials or service URLs stay in the existing editor. */
export function safeNativeStartup(command: string, startupArgs: readonly string[]): boolean {
  return ![command, ...startupArgs].some((arg) =>
    /(?:api[_-]?key|token|password|secret|authorization|https?:\/\/)/i.test(arg),
  );
}
/** Discovery is read-only. No auth files, full agent launches, prompts or login probes. */
export function discoverNativeRuntimes(projectRoot: string, options: DiscoveryOptions = {}) {
  const home = options.home ?? homedir();
  const commandFor = options.commandFor ?? resolveCliCommand;
  const intranet = options.intranet ?? process.env.CAT_CAFE_INTRANET_EDITION === '1';
  const codex = metadata(join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml'), true);
  const claude = nativeClaudeConfiguration(projectRoot, home);
  const builtins = (
    [
      ['codex', 'Codex', 'openai'],
      ['claude', 'Claude Code', 'anthropic'],
    ] as const
  ).map(([id, label, clientId]) => {
    const command = commandFor(id);
    const configuredModel = text(id === 'codex' ? codex.model : claude.model);
    const configuredEffort = text(id === 'codex' ? codex.model_reasoning_effort : claude.effort);
    const models = new Set<string>();
    if (configuredModel) models.add(configuredModel);
    return nativeTool(
      {
        id,
        label,
        clientId,
        installed: Boolean(command),
        command: command ?? undefined,
        configuredModel,
        configuredEffort,
        models: [...models],
        defaultsStatus: 'configured_only',
        transport: id === 'codex' ? 'app_server' : 'stream_json',
      },
      id === 'claude' ? 'claudecode' : 'codex',
    );
  });
  const acp = Object.values(catRegistry.getAllConfigs()).flatMap((cat) => {
    const config = getAcpConfig(cat.id, projectRoot);
    if (!config || (cat.agentProvider !== undefined ? cat.agentProvider : config.agentProvider)) return [];
    const command = isAbsolute(config.command) ? config.command : commandFor(config.command);
    const entry = config.startupArgs.find((arg) => /(?:\.m?js|\.cjs)$/.test(arg));
    const installed = Boolean(command && existsSync(command) && (!entry || existsSync(resolve(projectRoot, entry))));
    const profileState = dshLauncherProfileState(config.command, config.startupArgs, projectRoot);
    const harnessId = nativeBindingHarness(config.command, config.startupArgs, projectRoot);
    const selectable = safeNativeStartup(config.command, config.startupArgs) && profileState !== 'acp_profile_invalid';
    return [
      {
        id: `acp:${cat.id}`,
        label: cat.displayName,
        kind: 'binding' as const,
        sourceCatId: cat.id,
        harnessId,
        ...(intranet && harnessId === 'dsh'
          ? { dshSetupRequired: !hasPersistedDshSetup(config.startupArgs, projectRoot) }
          : {}),
        clientId: 'acp',
        installed,
        ...(profileState && profileState !== 'custom_startup'
          ? { discoveryStatus: installed ? profileState : 'not_installed' }
          : {}),
        ...(selectable
          ? {
              command: config.command,
              startupArgs: config.startupArgs,
              acp: { command: config.command, startupArgs: config.startupArgs, transport: config.transport },
            }
          : {}),
        models: cat.defaultModel ? [cat.defaultModel] : [],
        defaultsStatus: 'session_only',
        transport: 'acp',
      },
    ];
  });
  const dsh = nativeTool(
    discoverDshRuntime({
      resolveCommand: commandFor,
      dshHome: process.env.DSH_HOME || join(home, '.dsh'),
      requireSetup: intranet,
      ...(options.home ? { npmCaches: [] } : {}),
    }),
    'dsh',
  );
  const additional = intranet
    ? [nativeTool(discoverPiRuntime({ home, commandFor }), 'pi')]
    : discoverAdditionalRuntimes(home, commandFor).map((runtime) =>
        nativeTool(runtime, runtime.id === 'pi' ? 'pi' : 'kimi'),
      );
  return {
    edition: intranet ? ('intranet' as const) : ('public' as const),
    runtimes: [...discoverCodeAgentRuntimes(commandFor, intranet), ...builtins, ...acp, dsh, ...additional],
    authenticationStatus: 'not_checked',
  };
}

/** Bounded native login checks, without prompts, model requests, or refreshing credentials. */
export async function discoverNativeRuntimesWithReadiness(root: string, refresh = false) {
  const found = discoverNativeRuntimes(root);
  const runtimes = await Promise.all(
    found.runtimes.map(async (runtime) => ({
      ...runtime,
      readiness: await nativeRuntimeReadiness(runtime, root, refresh),
      ...(found.edition === 'intranet' &&
      runtime.harnessId === 'dsh' &&
      'dshSetupRequired' in runtime &&
      runtime.dshSetupRequired
        ? { dshSetup: await inspectDshRecommendation(runtime, root, refresh) }
        : {}),
    })),
  );
  return { edition: found.edition, runtimes, authenticationStatus: 'local_checked' };
}
