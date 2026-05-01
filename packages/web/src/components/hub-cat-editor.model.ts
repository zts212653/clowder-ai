import {
  builtinAccountFamilyForClient,
  CLI_EFFORT_VALUES,
  type CliEffortValue,
  getCliEffortOptionsForProvider,
  builtinAccountIdForClient as sharedBuiltinAccountIdForClient,
} from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';

/** clowder-ai#340 P5: Renamed from ClientValue → ClientId (aligned with shared type). */
export type ClientId = 'anthropic' | 'openai' | 'google' | 'kimi' | 'dare' | 'opencode' | 'antigravity' | 'catagent';
/** @deprecated clowder-ai#340: Use {@link ClientId} instead. */
export type ClientValue = ClientId;
export type SessionChainValue = 'true' | 'false';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

export interface HubCatEditorFormState {
  catId: string;
  name: string;
  displayName: string;
  variantLabel: string;
  nickname: string;
  avatar: string;
  colorPrimary: string;
  colorSecondary: string;
  mentionPatterns: string;
  roleDescription: string;
  personality: string;
  teamStrengths: string;
  caution: string;
  strengths: string;
  clientId: ClientId;
  accountRef: string;
  defaultModel: string;
  commandArgs: string;
  cliConfigArgs: string[];
  cliEffort: CliEffortValue | '';
  /** clowder-ai#340 P5: Model provider name (renamed from ocProviderName). */
  provider: string;
  sessionChain: SessionChainValue;
  maxPromptTokens: string;
  maxContextTokens: string;
  maxMessages: string;
  maxContentLengthPerMsg: string;
}

export interface HubCatEditorDraft {
  clientId: ClientId;
  accountRef?: string;
  defaultModel: string;
  commandArgs?: string;
  /** F171: template identity fields for bootcamp-guided cat creation */
  templateName?: string;
  templateNickname?: string;
  templateAvatar?: string;
  templateColorPrimary?: string;
  templateColorSecondary?: string;
  templateRoleDescription?: string;
  templatePersonality?: string;
  templateTeamStrengths?: string;
}

export interface StrategyFormState {
  strategy: StrategyType;
  warnThreshold: string;
  actionThreshold: string;
  maxCompressions: string;
  hybridCapable: boolean;
  sessionChainEnabled: boolean;
}

export interface CodexRuntimeSettings {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  authMode: CodexAuthMode;
}

export const CLIENT_OPTIONS: Array<{ value: ClientId; label: string }> = [
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai', label: 'Codex' },
  { value: 'google', label: 'Gemini' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'dare', label: 'Dare' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'catagent', label: 'CatAgent' },
];

export const SESSION_CHAIN_OPTIONS: Array<{ value: SessionChainValue; label: string }> = [
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' },
];

export const SESSION_STRATEGY_OPTIONS: Array<{ value: StrategyType; label: string }> = [
  { value: 'handoff', label: 'handoff' },
  { value: 'compress', label: 'compress' },
  { value: 'hybrid', label: 'hybrid' },
];

export const CODEX_SANDBOX_OPTIONS: Array<{ value: CodexSandboxMode; label: string }> = [
  { value: 'read-only', label: 'read-only' },
  { value: 'workspace-write', label: 'workspace-write' },
  { value: 'danger-full-access', label: 'danger-full-access' },
];

export const CODEX_APPROVAL_OPTIONS: Array<{ value: CodexApprovalPolicy; label: string }> = [
  { value: 'untrusted', label: 'untrusted' },
  { value: 'on-failure', label: 'on-failure' },
  { value: 'on-request', label: 'on-request' },
  { value: 'never', label: 'never' },
];

export const CODEX_AUTH_MODE_OPTIONS: Array<{ value: CodexAuthMode; label: string }> = [
  { value: 'oauth', label: 'oauth' },
  { value: 'api_key', label: 'api_key' },
  { value: 'auto', label: 'auto' },
];

export const DEFAULT_ANTIGRAVITY_COMMAND_ARGS = '. --remote-debugging-port=9000';

const GOOGLE_OWNED_DOMAINS = ['generativelanguage.googleapis.com', 'googleapis.com'];

function isCliEffortValue(value: string | undefined): value is CliEffortValue {
  return value !== undefined && CLI_EFFORT_VALUES.includes(value as CliEffortValue);
}

export function getCliEffortOptionsForClient(client: ClientValue): readonly CliEffortValue[] | null {
  return getCliEffortOptionsForProvider(client);
}

export function splitMentionPatterns(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function normalizeMentionPattern(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function deriveModelMentionPattern(model: string): string {
  const modelId = model.trim().split('/').filter(Boolean).at(-1)?.trim();
  if (!modelId) return '';
  const alias = modelId
    .replace(/^[@.]+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return alias ? normalizeMentionPattern(alias) : '';
}

export function withDefaultModelMentionPattern(form: HubCatEditorFormState): HubCatEditorFormState {
  const modelAlias = deriveModelMentionPattern(form.defaultModel);
  if (!modelAlias) return form;
  const aliases = splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean);
  if (aliases.length > 0) return form;
  return { ...form, mentionPatterns: joinTags([modelAlias]) };
}

export function canonicalMentionPattern(catId: string): string {
  return normalizeMentionPattern(catId);
}

export function joinTags(tags: string[]): string {
  return tags.join(', ');
}

export function splitCommandArgs(raw: string): string[] {
  const input = raw.trim();
  if (!input) return [];
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length === 0) return;
    args.push(current);
    current = '';
  };

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  pushCurrent();
  return args;
}

export function splitStrengthTags(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isBuiltinClient(client: ClientId): client is BuiltinAccountClient {
  return (
    client === 'anthropic' ||
    client === 'openai' ||
    client === 'google' ||
    client === 'kimi' ||
    client === 'dare' ||
    client === 'opencode'
  );
}

function legacyProfileClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.clientId) return profile.clientId;
  if (profile.oauthLikeClient === 'dare' || profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('kimi') || normalizedId.includes('moonshot')) return 'kimi';
  if (normalizedId.includes('dare')) return 'dare';
  if (normalizedId.includes('opencode')) return 'opencode';
  return undefined;
}

function parseHostname(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isOfficialGoogleHostname(hostname: string): boolean {
  return GOOGLE_OWNED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isAllowedGoogleGatewayProfile(profile: ProfileItem): boolean {
  if (profile.authType !== 'api_key') return false;
  const hostname = parseHostname(profile.baseUrl);
  return hostname !== null && !isOfficialGoogleHostname(hostname);
}

function resolveBuiltinClientFamily(client: ClientId): BuiltinAccountClient | null {
  if (typeof builtinAccountFamilyForClient === 'function') {
    const family = builtinAccountFamilyForClient(client);
    if (family) return family;
  }
  if (isBuiltinClient(client)) return client;
  if (client === 'catagent') return 'anthropic';
  return null;
}

export function builtinAccountIdForClient(client: ClientId): string | null {
  return sharedBuiltinAccountIdForClient(client);
}

export function filterAccounts(client: ClientId, profiles: ProfileItem[]): ProfileItem[] {
  const effective = resolveBuiltinClientFamily(client);
  if (!effective || !isBuiltinClient(effective)) return [];
  const builtinProfiles = profiles.filter(
    (profile) => profile.authType !== 'api_key' && legacyProfileClient(profile) === effective,
  );
  if (effective === 'google') {
    const gatewayProfiles = profiles.filter(isAllowedGoogleGatewayProfile);
    return [...builtinProfiles, ...gatewayProfiles.filter((profile) => !builtinProfiles.includes(profile))];
  }
  if (effective === 'kimi') {
    const kimiApiProfiles = profiles.filter(
      (profile) => profile.authType === 'api_key' && legacyProfileClient(profile) === 'kimi',
    );
    return [...builtinProfiles, ...kimiApiProfiles.filter((profile) => !builtinProfiles.includes(profile))];
  }
  const apiKeyProfiles = profiles.filter((profile) => profile.authType === 'api_key');
  return [...builtinProfiles, ...apiKeyProfiles.filter((profile) => !builtinProfiles.includes(profile))];
}

export const filterProfiles = filterAccounts;

export function autoSlug(name: string, currentId?: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  if (/^[a-z]/.test(slug)) return slug;
  if (currentId && /^cat-[a-z0-9]+$/.test(currentId)) return currentId;
  const rand = Math.random().toString(36).substring(2, 10);
  return `cat-${rand}`;
}

export function initialState(cat?: CatData | null, draft?: HubCatEditorDraft | null): HubCatEditorFormState {
  const createDraft = !cat ? draft : null;
  const persistedCliEffort = cat?.cli?.effort;
  const nameForCreate = createDraft?.templateName ?? '';
  const catId = cat?.id ?? (nameForCreate ? autoSlug(nameForCreate) : '');
  const mentionPatterns = cat?.mentionPatterns ?? [];
  return {
    catId,
    name: cat?.name ?? cat?.displayName ?? createDraft?.templateName ?? '',
    displayName: cat?.displayName ?? cat?.name ?? createDraft?.templateName ?? '',
    variantLabel: cat?.variantLabel ?? '',
    nickname: cat?.nickname ?? createDraft?.templateNickname ?? '',
    avatar: cat?.avatar ?? createDraft?.templateAvatar ?? '',
    colorPrimary: cat?.color.primary ?? createDraft?.templateColorPrimary ?? '#9B7EBD',
    colorSecondary: cat?.color.secondary ?? createDraft?.templateColorSecondary ?? '#E8DFF5',
    mentionPatterns: joinTags(mentionPatterns),
    roleDescription: cat?.roleDescription ?? createDraft?.templateRoleDescription ?? '',
    personality: cat?.personality ?? createDraft?.templatePersonality ?? '',
    teamStrengths: cat?.teamStrengths ?? createDraft?.templateTeamStrengths ?? '',
    caution: cat?.caution ?? '',
    strengths: cat?.strengths?.join(', ') ?? '',
    clientId: (cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic',
    accountRef: cat?.accountRef ?? createDraft?.accountRef ?? '',
    defaultModel: cat?.defaultModel ?? createDraft?.defaultModel ?? '',
    commandArgs: cat?.commandArgs?.join(' ') ?? createDraft?.commandArgs ?? '',
    cliConfigArgs: [...(cat?.cliConfigArgs ?? [])],
    cliEffort: isCliEffortValue(persistedCliEffort) ? persistedCliEffort : '',
    provider: cat?.provider ?? '',
    sessionChain: String(cat?.sessionChain ?? true) as SessionChainValue,
    maxPromptTokens: cat?.contextBudget ? String(cat.contextBudget.maxPromptTokens) : '',
    maxContextTokens: cat?.contextBudget ? String(cat.contextBudget.maxContextTokens) : '',
    maxMessages: cat?.contextBudget ? String(cat.contextBudget.maxMessages) : '',
    maxContentLengthPerMsg: cat?.contextBudget ? String(cat.contextBudget.maxContentLengthPerMsg) : '',
  };
}

export function toStrategyForm(entry: CatStrategyEntry): StrategyFormState {
  return {
    strategy: entry.effective.strategy,
    warnThreshold: String(entry.effective.thresholds.warn),
    actionThreshold: String(entry.effective.thresholds.action),
    maxCompressions: String(entry.effective.hybrid?.maxCompressions ?? 2),
    hybridCapable: entry.hybridCapable,
    sessionChainEnabled: entry.sessionChainEnabled,
  };
}

export function buildStrategyPayload(strategy: StrategyFormState) {
  const warn = Number.parseFloat(strategy.warnThreshold);
  const action = Number.parseFloat(strategy.actionThreshold);
  if (!Number.isFinite(warn) || !Number.isFinite(action)) {
    throw new Error('Session 阈值必须是数字');
  }
  if (warn >= action) {
    throw new Error('Warn Threshold 必须小于 Action Threshold');
  }

  const payload: Record<string, unknown> = {
    strategy: strategy.strategy,
    thresholds: { warn, action },
  };
  if (strategy.strategy === 'hybrid') {
    const maxCompressions = Number.parseInt(strategy.maxCompressions, 10);
    if (!Number.isFinite(maxCompressions) || maxCompressions <= 0) {
      throw new Error('Max Compressions 必须是正整数');
    }
    payload.hybrid = { maxCompressions };
  }
  return payload;
}

export function toCodexRuntimeSettings(config?: {
  cli?: {
    codexSandboxMode?: CodexSandboxMode;
    codexApprovalPolicy?: CodexApprovalPolicy;
  };
  codexExecution?: {
    authMode?: CodexAuthMode;
  };
}): CodexRuntimeSettings {
  return {
    sandboxMode: config?.cli?.codexSandboxMode ?? 'workspace-write',
    approvalPolicy: config?.cli?.codexApprovalPolicy ?? 'on-request',
    authMode: config?.codexExecution?.authMode ?? 'oauth',
  };
}

export function buildCodexConfigPatches(
  settings: CodexRuntimeSettings,
  baseline: CodexRuntimeSettings,
): Array<{ key: string; value: string }> {
  const patches: Array<{ key: string; value: string }> = [];
  if (settings.sandboxMode !== baseline.sandboxMode) {
    patches.push({ key: 'cli.codexSandboxMode', value: settings.sandboxMode });
  }
  if (settings.approvalPolicy !== baseline.approvalPolicy) {
    patches.push({ key: 'cli.codexApprovalPolicy', value: settings.approvalPolicy });
  }
  if (settings.authMode !== baseline.authMode) {
    patches.push({ key: 'codex.execution.authMode', value: settings.authMode });
  }
  return patches;
}

// Extracted to hub-cat-editor.payload.ts:
// buildCatPayload, buildContextBudget, hintModelFormatForClient, validateModelFormatForClient
export {
  buildCatPayload,
  buildContextBudget,
  hintModelFormatForClient,
  validateModelFormatForClient,
} from './hub-cat-editor.payload';
