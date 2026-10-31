import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { resolveKimiCliRuntime, resolveKimiRuntimePaths } from '../utils/kimi-cli-runtime.js';
import { discoverPiRuntime } from './native-pi-discovery.js';

function metadata(file: string, toml = false): Record<string, unknown> {
  try {
    const raw = readFileSync(file, 'utf8');
    const value: unknown = toml ? parse(raw) : JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Reads only model identifiers; credentials and full configs never leave this boundary. */
export function discoverAdditionalRuntimes(
  home: string,
  commandFor: typeof resolveCliCommand = resolveCliCommand,
  options: { piBridgeEntry?: string } = {},
) {
  const kimiRuntime = resolveKimiCliRuntime(commandFor);
  const kimi = metadata(resolveKimiRuntimePaths(process.env, home).configPath, true);
  const native = ([['kimi', 'Kimi', kimi, text(kimi.default_model)]] as const).map(
    ([id, label, config, configuredModel]) => {
      const command = id === 'kimi' ? kimiRuntime?.command : commandFor(id);
      const models = new Set(configuredModel ? [configuredModel] : []);
      if (id === 'kimi' && config.models && typeof config.models === 'object')
        for (const model of Object.keys(config.models)) models.add(model);
      return {
        id,
        label,
        clientId: id,
        command: command ?? undefined,
        installed: Boolean(command),
        configuredModel,
        models: [...models],
        defaultsStatus: 'configured_only',
        transport: id === 'kimi' ? 'stream_json' : 'json',
      };
    },
  );
  return [...native, discoverPiRuntime({ home, commandFor, bridgeEntry: options.piBridgeEntry })];
}
