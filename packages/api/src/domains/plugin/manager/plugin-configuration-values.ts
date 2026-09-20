import type { ConfigurationField } from '@clowder-ai/plugin-contract';

function scalarValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** Resolves the value the Host will actually expose to a plugin runtime. */
export function effectivePluginConfigurationValue(
  field: ConfigurationField,
  persistedValue: unknown,
): string | undefined {
  return scalarValue(persistedValue) ?? scalarValue(field.default);
}
