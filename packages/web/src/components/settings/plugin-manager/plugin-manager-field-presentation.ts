import type { PluginManagerConfigField } from '@cat-cafe/shared';

export type StringListFormat = 'json' | 'csv';

const githubLabels = new Map([
  ['GITHUB_TOKEN', '个人访问令牌（Personal Access Token）'],
  ['GITHUB_MCP_PAT', 'MCP 访问令牌（MCP Token）'],
  ['GITHUB_SETUP_NOISE_BOT_LOGINS', '要忽略的机器人账号'],
]);

/** Presentation only: keep field keys, types, defaults and submitted values unchanged. */
export function pluginFieldLabel(pluginId: string, field: PluginManagerConfigField): string {
  return pluginId === 'github' ? (githubLabels.get(field.key) ?? field.label) : field.label;
}

export function pluginListFormat(pluginId: string, field: PluginManagerConfigField): StringListFormat | undefined {
  if (field.sensitive) return undefined;
  if (field.kind === 'list') return 'json';
  // The repository GitHub consumer splits this exact string field on commas.
  if (pluginId === 'github' && field.kind === 'string' && field.key === 'GITHUB_SETUP_NOISE_BOT_LOGINS') return 'csv';
  return undefined;
}

export function parsePluginList(value: string, format: StringListFormat): string[] | undefined {
  if (format === 'csv')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  if (value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}
