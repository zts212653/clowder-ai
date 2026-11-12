import { resolveCliCommand } from '../utils/cli-resolve.js';
import { resolveKimiCliRuntime, resolveKimiRuntimePaths } from '../utils/kimi-cli-runtime.js';
import { readKimiModelMetadata } from '../utils/kimi-model-metadata.js';
import { discoverPiRuntime } from './native-pi-discovery.js';

/** Reads model metadata; credentials and full configs never leave this boundary. */
export function discoverAdditionalRuntimes(
  home: string,
  commandFor: typeof resolveCliCommand = resolveCliCommand,
  options: { piBridgeEntry?: string } = {},
) {
  const kimiRuntime = resolveKimiCliRuntime(commandFor);
  const kimi = readKimiModelMetadata(resolveKimiRuntimePaths(process.env, home).configPath);
  const configuredModel = kimi?.defaultModel;
  const modelCatalog =
    kimi?.models.map((model) => ({
      value: model.alias,
      label: model.alias,
      defaultEffort: model.defaultEffort,
      efforts: (model.efforts ?? []).map((value) => ({ value, label: value })),
    })) ?? [];
  const native = [
    {
      id: 'kimi',
      label: 'Kimi',
      clientId: 'kimi' as const,
      command: kimiRuntime?.command,
      installed: Boolean(kimiRuntime),
      configuredModel,
      configuredEffort: modelCatalog.find((model) => model.value === configuredModel)?.defaultEffort,
      configuredThinkingEnabled: kimi?.thinkingEnabled,
      modelCatalog,
      models: [
        ...new Set([...(configuredModel ? [configuredModel] : []), ...modelCatalog.map((model) => model.value)]),
      ],
      defaultsStatus: 'configured_only',
      transport: 'stream_json',
    },
  ];
  return [...native, discoverPiRuntime({ home, commandFor, bridgeEntry: options.piBridgeEntry })];
}
