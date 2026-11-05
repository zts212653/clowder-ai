import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliCommand } from '../utils/cli-resolve.js';

type Options = { home: string; commandFor?: typeof resolveCliCommand; bridgeEntry?: string };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function metadata(file: string): Record<string, unknown> {
  try {
    return object(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

function piModelMetadata(agentDir: string) {
  const settings = metadata(join(agentDir, 'settings.json'));
  const configuredModel =
    typeof settings.defaultProvider === 'string' && typeof settings.defaultModel === 'string'
      ? JSON.stringify([settings.defaultProvider, settings.defaultModel])
      : undefined;
  const models = new Set<string>(configuredModel ? [configuredModel] : []);
  for (const [provider, value] of Object.entries(object(metadata(join(agentDir, 'models.json')).providers))) {
    for (const item of Array.isArray(object(value).models) ? (object(value).models as unknown[]) : []) {
      const model = object(item);
      if (typeof model.id === 'string') models.add(JSON.stringify([provider, model.id]));
    }
  }
  return { configuredModel, models: [...models] };
}

/** Reads model identifiers only. A native Pi RPC CLI is never sent ACP requests directly. */
export function discoverPiRuntime({ home, commandFor = resolveCliCommand, bridgeEntry }: Options) {
  const pi = commandFor('pi');
  const external = pi ? commandFor('pi-acp') : null;
  const entry =
    bridgeEntry ??
    fileURLToPath(new URL('../domains/cats/services/agents/providers/pi/pi-acp-bridge.js', import.meta.url));
  const available = Boolean(pi && (external || existsSync(entry)));
  const command = external ?? (available ? process.execPath : undefined);
  const startupArgs = external ? [] : [entry, '--pi-command', pi ?? ''];
  return {
    id: 'pi',
    label: 'Pi',
    clientId: 'acp' as const,
    installed: Boolean(pi),
    command,
    ...(available && command ? { acp: { command, startupArgs, transport: 'stdio' as const } } : {}),
    discoveryStatus: !pi ? 'not_installed' : available ? 'configured' : 'adapter_missing',
    ...piModelMetadata(process.env.PI_CODING_AGENT_DIR || join(home, '.pi/agent')),
    defaultsStatus: 'session_only',
    transport: 'acp',
  };
}
