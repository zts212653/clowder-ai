export const BUILTIN_GPT_PRO_CAT_ID = 'gpt-pro' as const;
export const BUILTIN_GPT_PRO_CANONICAL_MENTION = '@gpt-pro' as const;

export const BUILTIN_GPT_PRO_IDENTITY = {
  breedId: BUILTIN_GPT_PRO_CAT_ID,
  clientId: 'openai',
  defaultModel: 'gpt-pro',
  provider: 'openai-chatgpt-pro',
  mcpSupport: true,
  builtinAccountRef: 'codex',
} as const;

export const BUILTIN_CLOUD_IDENTITY_LOCKED_FIELDS = [
  'breedId',
  'clientId',
  'defaultModel',
  'provider',
  'mcpSupport',
  'accountRef',
  'cli',
  'commandArgs',
  'cliConfigArgs',
  'acp',
] as const;

export type BuiltinCloudIdentityLockedField = (typeof BUILTIN_CLOUD_IDENTITY_LOCKED_FIELDS)[number];
export type BuiltinCloudIdentityProtectedField = BuiltinCloudIdentityLockedField | 'mentionPatterns';

export interface BuiltinCloudIdentityCandidate {
  id: string;
  breedId?: string | null;
  clientId?: string | null;
  defaultModel?: string | null;
  provider?: string | null;
  mcpSupport?: boolean | null;
  accountRef?: string | null;
  cli?: unknown;
  commandArgs?: readonly string[] | null;
  cliConfigArgs?: readonly string[] | null;
  acp?: unknown;
  mentionPatterns?: readonly string[] | null;
}

export interface BuiltinCloudIdentityProtection {
  kind: 'builtin-cloud';
  state: 'healthy' | 'drifted';
  lockedFields: BuiltinCloudIdentityLockedField[];
  driftedFields: BuiltinCloudIdentityProtectedField[];
}

export function isBuiltinGptProIdentity(catId: string): boolean {
  return catId === BUILTIN_GPT_PRO_CAT_ID;
}

export function hasBuiltinGptProCanonicalMention(patterns: readonly string[] | null | undefined): boolean {
  return (
    patterns?.some((pattern) => {
      const normalized = pattern.trim().toLowerCase();
      return (normalized.startsWith('@') ? normalized : `@${normalized}`) === BUILTIN_GPT_PRO_CANONICAL_MENTION;
    }) ?? false
  );
}

function hasConfiguredValue(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Project the built-in cloud identity invariant without mutating operator state.
 * The effective builtin Codex account ref is tolerated because account resolution
 * can project it even when no accountRef byte is persisted in the runtime catalog.
 */
export function projectBuiltinCloudIdentityProtection(
  candidate: BuiltinCloudIdentityCandidate,
): BuiltinCloudIdentityProtection | undefined {
  if (!isBuiltinGptProIdentity(candidate.id)) return undefined;

  const driftedFields: BuiltinCloudIdentityProtectedField[] = [];
  if (candidate.breedId != null && candidate.breedId !== BUILTIN_GPT_PRO_IDENTITY.breedId) {
    driftedFields.push('breedId');
  }
  if (candidate.clientId !== BUILTIN_GPT_PRO_IDENTITY.clientId) driftedFields.push('clientId');
  if (candidate.defaultModel !== BUILTIN_GPT_PRO_IDENTITY.defaultModel) driftedFields.push('defaultModel');
  if (candidate.provider !== BUILTIN_GPT_PRO_IDENTITY.provider) driftedFields.push('provider');
  if (candidate.mcpSupport !== BUILTIN_GPT_PRO_IDENTITY.mcpSupport) driftedFields.push('mcpSupport');
  if (
    candidate.accountRef != null &&
    candidate.accountRef !== '' &&
    candidate.accountRef !== BUILTIN_GPT_PRO_IDENTITY.builtinAccountRef
  ) {
    driftedFields.push('accountRef');
  }
  if (hasConfiguredValue(candidate.cli)) driftedFields.push('cli');
  if (hasConfiguredValue(candidate.commandArgs)) driftedFields.push('commandArgs');
  if (hasConfiguredValue(candidate.cliConfigArgs)) driftedFields.push('cliConfigArgs');
  if (hasConfiguredValue(candidate.acp)) driftedFields.push('acp');
  if (!hasBuiltinGptProCanonicalMention(candidate.mentionPatterns)) driftedFields.push('mentionPatterns');

  return {
    kind: 'builtin-cloud',
    state: driftedFields.length === 0 ? 'healthy' : 'drifted',
    lockedFields: [...BUILTIN_CLOUD_IDENTITY_LOCKED_FIELDS],
    driftedFields,
  };
}
