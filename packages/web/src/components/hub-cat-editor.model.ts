import type { CatData } from '@/hooks/useCatData';
import type { BuiltinAccountClient, ProfileItem } from './hub-provider-profiles.types';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';
import { defaultMcpSupportForClient } from './hub-cat-editor.protocols';

export type ClientValue = 'anthropic' | 'openai' | 'google' | 'dare' | 'opencode' | 'antigravity';
export type SessionChainValue = 'true' | 'false';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

export interface HubCatEditorFormState {
  catId: string;
  name: string;
  displayName: string;
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
  client: ClientValue;
  accountRef: string;
  defaultModel: string;
  commandArgs: string;
  cliConfigArgs: string[];
  sessionChain: SessionChainValue;
  maxPromptTokens: string;
  maxContextTokens: string;
  maxMessages: string;
  maxContentLengthPerMsg: string;
}

export interface HubCatEditorDraft {
  client: ClientValue;
  accountRef?: string;
  providerProfileId?: string;
  defaultModel: string;
  commandArgs?: string;
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

export const CLIENT_OPTIONS: Array<{ value: ClientValue; label: string }> = [
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai', label: 'Codex' },
  { value: 'google', label: 'Gemini' },
  { value: 'dare', label: 'Dare' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'antigravity', label: 'Antigravity' },
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

function isBuiltinClient(client: ClientValue): client is BuiltinAccountClient {
  return client === 'anthropic' || client === 'openai' || client === 'google' || client === 'dare' || client === 'opencode';
}

function legacyProfileClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.client) return profile.client;
  if (profile.oauthLikeClient === 'dare' || profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('dare')) return 'dare';
  if (normalizedId.includes('opencode')) return 'opencode';
  switch (profile.protocol) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    default:
      return undefined;
  }
}

export function builtinAccountIdForClient(client: ClientValue): string | null {
  if (!isBuiltinClient(client)) return null;
  switch (client) {
    case 'anthropic':
      return 'claude';
    case 'openai':
      return 'codex';
    case 'google':
      return 'gemini';
    case 'dare':
      return 'dare';
    case 'opencode':
      return 'opencode';
  }
}

export function filterAccounts(client: ClientValue, profiles: ProfileItem[]): ProfileItem[] {
  if (!isBuiltinClient(client)) return [];
  const builtinProfiles = profiles.filter(
    (profile) => profile.authType !== 'api_key' && legacyProfileClient(profile) === client,
  );
  // Gemini CLI only supports builtin Google auth — no API key profiles.
  if (client === 'google') return builtinProfiles;
  const apiKeyProfiles = profiles.filter((profile) => profile.authType === 'api_key');
  return [...builtinProfiles, ...apiKeyProfiles.filter((profile) => !builtinProfiles.includes(profile))];
}

export const filterProfiles = filterAccounts;

export function initialState(cat?: CatData | null, draft?: HubCatEditorDraft | null): HubCatEditorFormState {
  const createDraft = !cat ? draft : null;
  const catId = cat?.id ?? '';
  const mentionPatterns = cat?.mentionPatterns ?? (catId ? [canonicalMentionPattern(catId)] : []);
  return {
    catId,
    name: cat?.name ?? cat?.displayName ?? '',
    displayName: cat?.displayName ?? cat?.name ?? '',
    nickname: cat?.nickname ?? '',
    avatar: cat?.avatar ?? '',
    colorPrimary: cat?.color.primary ?? '#9B7EBD',
    colorSecondary: cat?.color.secondary ?? '#E8DFF5',
    mentionPatterns: joinTags(mentionPatterns),
    roleDescription: cat?.roleDescription ?? '',
    personality: cat?.personality ?? '',
    teamStrengths: cat?.teamStrengths ?? '',
    caution: cat?.caution ?? '',
    strengths: cat?.strengths?.join(', ') ?? '',
    client: (cat?.provider as ClientValue | undefined) ?? createDraft?.client ?? 'anthropic',
    accountRef:
      cat?.accountRef ??
      cat?.providerProfileId ??
      createDraft?.accountRef ??
      createDraft?.providerProfileId ??
      '',
    defaultModel: cat?.defaultModel ?? createDraft?.defaultModel ?? '',
    commandArgs: cat?.commandArgs?.join(' ') ?? createDraft?.commandArgs ?? '',
    cliConfigArgs: [...(cat?.cliConfigArgs ?? [])],
    sessionChain: String(cat?.sessionChain ?? true) as SessionChainValue,
    maxPromptTokens: cat?.contextBudget ? String(cat.contextBudget.maxPromptTokens) : '',
    maxContextTokens: cat?.contextBudget ? String(cat.contextBudget.maxContextTokens) : '',
    maxMessages: cat?.contextBudget ? String(cat.contextBudget.maxMessages) : '',
    maxContentLengthPerMsg: cat?.contextBudget ? String(cat.contextBudget.maxContentLengthPerMsg) : '',
  };
}

export function buildContextBudget(form: HubCatEditorFormState) {
  const values = [
    form.maxPromptTokens,
    form.maxContextTokens,
    form.maxMessages,
    form.maxContentLengthPerMsg,
  ].map((value) => value.trim());
  const filledCount = values.filter((value) => value.length > 0).length;
  if (filledCount === 0) return undefined;
  if (filledCount !== values.length) {
    throw new Error('上下文预算要么全部留空，要么 4 项都填写');
  }

  const parsed = values.map((value) => Number.parseInt(value, 10));
  if (parsed.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('上下文预算必须是正整数');
  }

  return {
    maxPromptTokens: parsed[0]!,
    maxContextTokens: parsed[1]!,
    maxMessages: parsed[2]!,
    maxContentLengthPerMsg: parsed[3]!,
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

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function validateModelFormatForClient(client: ClientValue, model: string): string | null {
  if (client !== 'opencode') return null;
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) return null;
  return 'OpenCode 的 Model 必须使用 providerId/modelId 格式（例如 openai/gpt-5.4）';
}

function resolveFormAccountRef(form: HubCatEditorFormState): string {
  return trimText(form.accountRef ?? (form as HubCatEditorFormState & { providerProfileId?: string }).providerProfileId);
}

export function buildCatPayload(form: HubCatEditorFormState, cat?: CatData | null) {
  const contextBudget = buildContextBudget(form);
  const hasExistingBudget = Boolean(cat?.contextBudget);
  const contextBudgetPatch =
    contextBudget !== undefined
      ? { contextBudget }
      : cat && hasExistingBudget
        ? { contextBudget: null as null }
        : {};
  const name = trimText(form.name);
  const displayName = trimText(form.displayName) || name;
  const createName = name || displayName;
  const updateName = name || displayName || cat?.name || cat?.displayName || '';
  const trimmedAccountRef = resolveFormAccountRef(form);
  const accountRefPatch =
    trimmedAccountRef.length > 0
      ? { accountRef: trimmedAccountRef }
      : cat?.accountRef || cat?.providerProfileId
        ? { accountRef: null as null }
        : {};
  const mcpSupportPatch =
    cat && form.client !== cat.provider ? { mcpSupport: defaultMcpSupportForClient(form.client) } : {};
  const common = {
    displayName,
    nickname: trimText(form.nickname),
    avatar: trimText(form.avatar),
    color: {
      primary: trimText(form.colorPrimary),
      secondary: trimText(form.colorSecondary),
    },
    mentionPatterns: Array.from(
      new Set(
        splitMentionPatterns(form.mentionPatterns)
          .map(normalizeMentionPattern)
          .filter(Boolean),
      ),
    ),
    roleDescription: trimText(form.roleDescription),
    personality: trimText(form.personality),
    teamStrengths: trimText(form.teamStrengths),
    caution: trimText(form.caution) || null,
    strengths: splitStrengthTags(form.strengths),
    sessionChain: form.sessionChain === 'true',
    ...contextBudgetPatch,
  };

  if (form.client === 'antigravity') {
    const commandArgsSource = trimText(form.commandArgs) || DEFAULT_ANTIGRAVITY_COMMAND_ARGS;
    return {
      ...common,
      ...(cat ? { name: updateName } : { catId: trimText(form.catId), name: createName }),
      client: 'antigravity' as const,
      ...accountRefPatch,
      ...mcpSupportPatch,
      defaultModel: trimText(form.defaultModel),
      commandArgs: splitCommandArgs(commandArgsSource),
    };
  }

  return {
    ...common,
    ...(cat ? { name: updateName } : { catId: trimText(form.catId), name: createName }),
    client: form.client,
    ...accountRefPatch,
    ...mcpSupportPatch,
    defaultModel: trimText(form.defaultModel),
    cliConfigArgs: (form.cliConfigArgs ?? []).filter((arg) => arg.trim().length > 0),
  };
}
