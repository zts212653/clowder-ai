import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { parse } from 'smol-toml';
import { getAcpConfig } from '../config/cat-config-loader.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';

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
export function discoverNativeRuntimes(projectRoot: string) {
  const home = homedir();
  const codex = metadata(join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml'), true);
  const claude = metadata(join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'));
  const builtins = (
    [
      ['codex', 'Codex', 'openai'],
      ['claude', 'Claude Code', 'anthropic'],
    ] as const
  ).map(([id, label, clientId]) => {
    const command = resolveCliCommand(id);
    const configuredModel = text(id === 'codex' ? codex.model : claude.model);
    const configuredEffort = text(id === 'codex' ? codex.model_reasoning_effort : claude.effortLevel);
    const models = new Set<string>();
    if (configuredModel) models.add(configuredModel);
    for (const entry of Object.values(catRegistry.getAllConfigs())) {
      if (entry.clientId === clientId && entry.defaultModel) models.add(entry.defaultModel);
    }
    return {
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
    };
  });
  const acp = Object.values(catRegistry.getAllConfigs()).flatMap((cat) => {
    const config = getAcpConfig(cat.id, projectRoot);
    if (!config) return [];
    const command = isAbsolute(config.command) ? config.command : resolveCliCommand(config.command);
    const entry = config.startupArgs.find((arg) => /(?:\.m?js|\.cjs)$/.test(arg));
    const installed = Boolean(command && existsSync(command) && (!entry || existsSync(resolve(projectRoot, entry))));
    const selectable = safeNativeStartup(config.command, config.startupArgs);
    return [
      {
        id: `acp:${cat.id}`,
        label: /dsh|deepseek/i.test([config.command, ...config.startupArgs].join(' ')) ? 'DSH' : cat.displayName,
        clientId: 'acp',
        installed,
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
  return { runtimes: [...builtins, ...acp], authenticationStatus: 'not_checked' };
}
