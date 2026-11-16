import {
  replayableSessionPreferences,
  reportedSessionModel,
} from '../domains/cats/services/agents/providers/acp/session-configuration.js';

/** Only advertised capabilities are selectable; configured values are a separate fallback. */
export interface CatalogOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}
export interface CatalogModel extends CatalogOption {
  resolvedModel?: string;
  efforts?: CatalogOption[];
  defaultEffort?: string;
}
export type CatalogSource = 'tool_config' | 'client_report' | 'account_config';
export interface RuntimeModelCatalog {
  thinkingEnabled?: boolean;
  status: 'live' | 'configured' | 'unavailable';
  models: CatalogModel[];
  defaultModel?: string;
  defaultModelLabel?: string;
  defaultModelStatus?: 'reported' | 'unreported' | 'unavailable';
  defaultEffort?: string;
  defaultEffortLabel?: string;
  defaultModelSource?: CatalogSource;
  defaultEffortSource?: CatalogSource;
  selectedModel?: string;
  selectedEffort?: string;
  selectedEffortLabel?: string;
  selectedEffortSource?: CatalogSource;
  effortOptions?: CatalogOption[];
  message?: string;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
export function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export function acpChoices(value: unknown, group?: string): CatalogOption[] {
  return rows(value).flatMap((item) => {
    if (Array.isArray(item.options)) return acpChoices(item.options, text(item.name) ?? text(item.group));
    const id = text(item.value);
    return id === undefined
      ? []
      : [{ value: id, label: text(item.name) ?? id, description: text(item.description), group }];
  });
}
export function acpOption(session: unknown, category: string) {
  return rows(record(session).configOptions).find(
    (item) => item.category === category || item.id === (category === 'thought_level' ? 'reasoning_effort' : category),
  );
}
export function parseAcpCatalog(session: unknown, defaults: unknown, _requested?: string): RuntimeModelCatalog {
  const model = acpOption(session, 'model');
  const effort = acpOption(session, 'thought_level');
  const nativeEffort = acpOption(defaults, 'thought_level');
  const nativePreferences = replayableSessionPreferences(record(defaults));
  const selectedPreferences = replayableSessionPreferences(record(session));
  const defaultEffort = nativePreferences.effort;
  const selectedEffort = selectedPreferences.effort;
  const nativeModel = acpOption(defaults, 'model');
  const nativeModels = acpChoices(nativeModel?.options);
  const reportedDefault = nativeModel ? reportedSessionModel({ configOptions: [nativeModel] }) : undefined;
  const defaultModel = nativePreferences.model;
  const defaultModelStatus =
    defaultModel !== undefined ? 'reported' : reportedDefault !== undefined ? 'unavailable' : 'unreported';
  const defaultChoice = nativeModels.find((item) => item.value === defaultModel);
  const defaultModelLabel = defaultChoice
    ? [defaultChoice.group, defaultChoice.label].filter(Boolean).join(' / ')
    : undefined;
  const models = acpChoices(model?.options);
  return {
    status: models.length ? 'live' : 'unavailable',
    models,
    defaultModel,
    defaultModelStatus,
    defaultModelLabel,
    defaultEffort,
    defaultEffortLabel: acpChoices(nativeEffort?.options).find((item) => item.value === defaultEffort)?.label,
    defaultModelSource: defaultModel !== undefined ? 'client_report' : undefined,
    defaultEffortSource: defaultEffort !== undefined ? 'client_report' : undefined,
    selectedModel: selectedPreferences.model,
    selectedEffort,
    selectedEffortLabel: acpChoices(effort?.options).find((item) => item.value === selectedEffort)?.label,
    selectedEffortSource: selectedEffort !== undefined ? 'client_report' : undefined,
    ...(effort ? { effortOptions: acpChoices(effort.options) } : {}),
  };
}
export function parseCodexModels(value: unknown): CatalogModel[] {
  return rows(record(value).data)
    .filter((item) => !item.hidden)
    .flatMap((item) => {
      const id = text(item.model) ?? text(item.id);
      return id
        ? [
            {
              value: id,
              label: text(item.displayName) ?? id,
              description: text(item.description),
              ...(Array.isArray(item.supportedReasoningEfforts)
                ? {
                    efforts: rows(item.supportedReasoningEfforts).flatMap((e) =>
                      typeof e.reasoningEffort === 'string'
                        ? [{ value: e.reasoningEffort, label: e.reasoningEffort, description: text(e.description) }]
                        : [],
                    ),
                  }
                : {}),
            },
          ]
        : [];
    });
}
export function parseClaudeModels(value: unknown): CatalogModel[] {
  return rows(value).flatMap((item) =>
    typeof item.value === 'string'
      ? [
          {
            value: item.value,
            resolvedModel: text(item.resolvedModel),
            label: text(item.displayName) ?? item.value,
            description: text(item.description),
            ...(item.supportsEffort === false
              ? { efforts: [] }
              : Array.isArray(item.supportedEffortLevels)
                ? {
                    efforts: item.supportedEffortLevels
                      .filter((v): v is string => typeof v === 'string')
                      .map((v) => ({ value: v, label: v })),
                  }
                : {}),
          },
        ]
      : [],
  );
}
