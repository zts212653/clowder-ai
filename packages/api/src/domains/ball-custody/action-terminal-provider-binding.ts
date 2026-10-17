import { isDeepStrictEqual } from 'node:util';

/** Host-selected installation authority for one custody generation, never action input. */
export interface ActionTerminalProviderBinding {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly featureId: string;
  readonly contributionId: string;
  readonly freshnessMethod: string;
  readonly completionMethod: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly tenantScope: string;
  readonly installationProjectRoot: string;
}

const stringFields = [
  'pluginInstanceId',
  'packageDigest',
  'featureId',
  'contributionId',
  'freshnessMethod',
  'completionMethod',
  'tenantScope',
  'installationProjectRoot',
] as const;
const revisionFields = ['grantRevision', 'lifecycleRevision'] as const;
const fields = new Set<string>([...stringFields, ...revisionFields]);

/** Legacy absence remains absence; malformed authority is never silently discarded. */
export function parseActionTerminalProviderBinding(
  value: unknown,
  tenantScope: string,
  hasPredicate = true,
): ActionTerminalProviderBinding | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error('invalid action terminal provider binding');
  if (!hasPredicate || !value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.size || Object.keys(record).some((key) => !fields.has(key)))
    throw invalid();
  for (const key of stringFields) {
    const field = record[key];
    if (
      typeof field !== 'string' ||
      !field.trim() ||
      field !== field.trim() ||
      [...field].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      throw invalid();
    }
  }
  for (const key of revisionFields) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 1) throw invalid();
  }
  if (record.tenantScope !== tenantScope || record.freshnessMethod === record.completionMethod) throw invalid();
  return { ...record } as unknown as ActionTerminalProviderBinding;
}

export function nextActionTerminalProviderBinding(
  previous: ActionTerminalProviderBinding | undefined,
  next: ActionTerminalProviderBinding | undefined,
  tenantScope: string,
): ActionTerminalProviderBinding | undefined {
  if (previous && next === undefined) throw new Error('freshly admitted provider binding is required');
  return parseActionTerminalProviderBinding(next, tenantScope);
}

export function actionTerminalProviderBindingsMatch(
  first: ActionTerminalProviderBinding | undefined,
  second: ActionTerminalProviderBinding | undefined,
): boolean {
  return isDeepStrictEqual(first, second);
}
