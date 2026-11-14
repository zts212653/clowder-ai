/** ACP owns option ids and opaque wire values; never reconstruct provider/model strings. */
export interface SessionConfigurationClient {
  setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<unknown>;
  closeSession?(sessionId: string): Promise<void>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function isUnknownModel(value: string): boolean {
  return value.trim().toLowerCase() === 'unknown' || /^\[\s*"unknown"\s*,\s*"unknown"\s*\]$/.test(value);
}

/** Absence/opaque unknown sentinels are not evidence of a selected model. */
export function reportedSessionModel(session: { configOptions?: unknown; models?: unknown }): string | undefined {
  const option = Array.isArray(session.configOptions)
    ? session.configOptions.find((value) => record(value) && (value.category === 'model' || value.id === 'model'))
    : undefined;
  const value =
    record(option) && typeof option.currentValue === 'string'
      ? option.currentValue
      : record(session.models)
        ? session.models.currentModelId
        : undefined;
  if (typeof value !== 'string' || !value.trim() || isUnknownModel(value)) return;
  return value;
}
function values(options: unknown): Array<{ value: string; name?: string }> {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!record(option)) return [];
    if (typeof option.value === 'string')
      return [{ value: option.value, ...(typeof option.name === 'string' ? { name: option.name } : {}) }];
    return values(option.options);
  });
}
/** Observations are replayable only as exact, unique advertised values, including an empty sentinel. */
export function replayableSessionPreferences(session: { configOptions?: unknown }) {
  const result: { model?: string; effort?: string } = {};
  if (!Array.isArray(session.configOptions)) return result;
  const options = session.configOptions.filter(record);
  (
    [
      ['model', 'model'],
      ['effort', 'thought_level'],
    ] as const
  ).forEach(([preference, kind]) => {
    const option = options.find(
      (item) => item.category === kind || item.id === (kind === 'model' ? 'model' : 'reasoning_effort'),
    );
    const value = option?.currentValue;
    if (typeof option?.id !== 'string' || typeof value !== 'string') return;
    if (kind === 'model' && isUnknownModel(value)) return;
    if (values(option.options).filter((choice) => choice.value === value).length === 1) result[preference] = value;
  });
  return result;
}
function matchesModelAlias(option: { value: string; name?: string }, requested: string): boolean {
  if (option.name === requested) return true;
  try {
    const parsed: unknown = JSON.parse(option.value);
    return Array.isArray(parsed) && parsed.length === 2 && parsed[1] === requested;
  } catch {
    const separator = option.value.indexOf('/');
    return separator > 0 && option.value.slice(separator + 1) === requested;
  }
}
export function resolveSessionOption(
  session: { configOptions?: unknown },
  kind: 'model' | 'thought_level',
  requested: string,
) {
  const options = session.configOptions;
  const correction = kind === 'model' ? '；请在成员设置重选模型，或清空模型以跟随工具默认设置' : '';
  if (!Array.isArray(options)) throw new Error(`ACP 未提供 ${kind} 配置选项${correction}`);
  const descriptor = options.find(
    (option) =>
      record(option) && (option.category === kind || option.id === (kind === 'model' ? 'model' : 'reasoning_effort')),
  );
  if (!record(descriptor) || typeof descriptor.id !== 'string') throw new Error(`ACP 不支持 ${kind} 覆盖${correction}`);
  const advertised = values(descriptor.options);
  let matches = advertised.filter((option) => option.value === requested);
  if (matches.length === 0 && kind === 'model') {
    matches = advertised.filter((option) => matchesModelAlias(option, requested));
  }
  const [matched] = matches;
  if (matches.length !== 1 || !matched) throw new Error(`ACP ${kind} 选项无效或不唯一: ${requested}${correction}`);
  return {
    configId: descriptor.id,
    value: matched.value,
    unchanged: descriptor.currentValue === matched.value,
  };
}
export async function applySessionConfiguration(
  client: SessionConfigurationClient,
  session: { sessionId: string; configOptions?: unknown; models?: unknown },
  preferences: { model?: string; effort?: string },
) {
  let current = session;
  for (const [kind, requested] of [
    ['model', preferences.model],
    ['thought_level', preferences.effort],
  ] as const) {
    // Empty strings can be advertised opaque default sentinels. Only undefined
    // means no preference; role inheritance is normalized before this boundary.
    if (requested === undefined) continue;
    const option = resolveSessionOption(current, kind, requested);
    if (option.unchanged) continue;
    const response = await client.setSessionConfigOption(session.sessionId, option.configId, option.value);
    if (!record(response) || !Array.isArray(response.configOptions)) throw new Error(`ACP ${kind} 未返回实际配置`);
    current = { ...current, configOptions: response.configOptions };
    const adopted = resolveSessionOption(current, kind, option.value);
    if (!adopted.unchanged) throw new Error(`ACP 未采用 ${kind} 覆盖`);
  }
  return current;
}
