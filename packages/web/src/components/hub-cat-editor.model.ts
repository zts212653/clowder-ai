import type { CatData } from '@/hooks/useCatData';
import type { ProfileItem } from './hub-provider-profiles.types';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';

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
  providerProfileId: string;
  defaultModel: string;
  commandArgs: string;
  sessionChain: SessionChainValue;
  maxPromptTokens: string;
  maxContextTokens: string;
  maxMessages: string;
  maxContentLengthPerMsg: string;
}

export interface HubCatEditorDraft {
  client: ClientValue;
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
  return raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function splitStrengthTags(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function protocolForClient(client: ClientValue): 'anthropic' | 'openai' | 'google' | null {
  switch (client) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'dare':
      return 'openai';
    case 'opencode':
      return 'anthropic';
    default:
      return null;
  }
}

export function filterProfiles(client: ClientValue, profiles: ProfileItem[]): ProfileItem[] {
  if (client === 'antigravity') return [];
  const protocol = protocolForClient(client);
  if (!protocol) return [];
  const scoped = profiles.filter((profile) => profile.protocol === protocol);
  if (client === 'dare' || client === 'opencode') {
    return scoped.filter((profile) => profile.authType === 'api_key');
  }
  return scoped;
}

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
    providerProfileId: cat?.providerProfileId ?? createDraft?.providerProfileId ?? '',
    defaultModel: cat?.defaultModel ?? createDraft?.defaultModel ?? '',
    commandArgs: cat?.commandArgs?.join(' ') ?? createDraft?.commandArgs ?? '',
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

function trimText(value: string): string {
  return value.trim();
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
  const common = {
    name: cat ? name || displayName : name,
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
          .filter(Boolean)
          .concat(!cat && form.catId.trim() ? [canonicalMentionPattern(form.catId.trim())] : []),
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
    return {
      ...common,
      ...(cat ? {} : { catId: trimText(form.catId) }),
      client: 'antigravity' as const,
      defaultModel: trimText(form.defaultModel),
      commandArgs: splitCommandArgs(form.commandArgs),
    };
  }

  return {
    ...common,
    ...(cat ? {} : { catId: trimText(form.catId) }),
    client: form.client,
    providerProfileId: form.providerProfileId || undefined,
    defaultModel: trimText(form.defaultModel),
  };
}
