import { reportedSessionModel } from '../domains/cats/services/agents/providers/acp/session-configuration.js';

/** Only advertised capabilities are selectable; configured values are a separate fallback. */
export interface CatalogOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}
export interface CatalogModel extends CatalogOption {
  efforts?: CatalogOption[];
}
export interface RuntimeModelCatalog {
  status: 'live' | 'configured' | 'unavailable';
  models: CatalogModel[];
  defaultModel?: string;
  defaultModelLabel?: string;
  defaultModelStatus?: 'reported' | 'unreported' | 'unavailable';
  defaultEffort?: string;
  selectedModel?: string;
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
  const legacy = record(record(session).models);
  const reportedDefault = reportedSessionModel(record(defaults));
  const defaultChoices = acpOption(defaults, 'model')
    ? acpChoices(acpOption(defaults, 'model')?.options).map((item) => item.value)
    : rows(record(record(defaults).models).availableModels).flatMap((item) =>
        typeof item.id === 'string' ? [item.id] : [],
      );
  const defaultModelStatus = !reportedDefault
    ? 'unreported'
    : defaultChoices.length && !defaultChoices.includes(reportedDefault)
      ? 'unavailable'
      : 'reported';
  const defaultModel = defaultModelStatus === 'reported' ? reportedDefault : undefined;
  const defaultModelLabel = acpChoices(acpOption(defaults, 'model')?.options).find(
    (item) => item.value === defaultModel,
  )?.label;
  const models = model
    ? acpChoices(model.options)
    : rows(legacy.availableModels).flatMap((item) =>
        typeof item.id === 'string' ? [{ value: item.id, label: text(item.name) ?? item.id }] : [],
      );
  return {
    status: models.length ? 'live' : 'unavailable',
    models,
    defaultModel,
    defaultModelStatus,
    defaultModelLabel,
    defaultEffort: text(acpOption(defaults, 'thought_level')?.currentValue),
    selectedModel: reportedSessionModel(record(session)),
    ...(model ? { effortOptions: effort ? acpChoices(effort.options) : [] } : {}),
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
