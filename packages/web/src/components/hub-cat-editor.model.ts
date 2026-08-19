import {
  builtinAccountFamilyForClient,
  type CliEffortPreset,
  getCliEffortOptionsForProvider,
  builtinAccountIdForClient as sharedBuiltinAccountIdForClient,
} from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';
import { defaultAcpCommandForClient, defaultAcpStartupArgsForClient } from './hub-cat-editor.acp';
import { defaultMcpSupportForClient } from './hub-cat-editor.protocols';
import type { CatStrategyEntry, StrategyType } from './hub-strategy-types';

export type ClientId = 'anthropic' | 'openai' | 'google' | 'kimi' | 'opencode' | 'antigravity' | 'catagent' | 'acp';
/** @deprecated Use ClientId instead. */
export type ClientValue = ClientId;
export type SessionChainValue = 'true' | 'false';

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
  cliEffort: string;
  /** F291: '' inherits Codex user config. Optional keeps legacy form fixtures source-compatible. */
  codexSpeed?: '' | 'standard' | 'fast';
  /** F254 D2: Codex carrier override. '' = 跟随服务端 CAT_CAFE_CODEX_CARRIER 环境变量。 */
  codexCarrier: '' | 'exec_json' | 'app_server';
  provider: string;
  acpEnabled: boolean;
  acpTransport: 'stdio' | 'httpstream';
  acpCommand: string;
  acpStartupArgs: string;
  acpMaxLiveProcesses: string;
  acpIdleTtlMinutes: string;
  mcpSupport: boolean;
  sessionChain: SessionChainValue;
  /** clowder-ai#1208: single context window cap; empty = Auto. */
  contextWindow: string;
  voiceVoice: string;
  voiceLangCode: string;
  voiceSpeed: string;
  voiceRefAudio: string;
  voiceRefText: string;
  voiceInstruct: string;
  voiceTemperature: string;
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
  /** Policy for which executionStatus was returned by the last server read. */
  statusStrategy: StrategyType;
  warnThreshold: string;
  actionThreshold: string;
  maxCompressions: string;
  source: string;
  revision: string;
  changedAt: number;
  executionStatus: NonNullable<CatStrategyEntry['executionStatus']>;
}

export const CLIENT_OPTIONS: Array<{ value: ClientId; label: string }> = [
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai', label: 'Codex' },
  { value: 'google', label: 'Gemini' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'catagent', label: 'CatAgent' },
  { value: 'acp', label: 'ACP Client' },
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

export const CODEX_CARRIER_OPTIONS: Array<{ value: HubCatEditorFormState['codexCarrier']; label: string }> = [
  { value: '', label: '默认（跟随服务端环境）' },
  { value: 'exec_json', label: 'CLI（codex exec）' },
  { value: 'app_server', label: 'App Server（池化常驻宿主）' },
];

export { defaultAcpCommandForClient, defaultAcpStartupArgsForClient };
export {
  ACP_TRANSPORT_OPTIONS,
  type AcpTransportValue,
  acpStartupArgsPlaceholder,
  getAcpWarning,
  isAcpOnlyClient,
  showTransportSelector,
} from './hub-cat-editor.acp';

export const DEFAULT_ANTIGRAVITY_COMMAND_ARGS = '. --remote-debugging-port=9000';

const GOOGLE_OWNED_DOMAINS = ['generativelanguage.googleapis.com', 'googleapis.com'];

function voiceStr(value: string | number | undefined): string {
  return value == null ? '' : String(value);
}

export function getCliEffortOptionsForClient(
  client: ClientValue,
  defaultModel?: string | null,
): readonly CliEffortPreset[] | null {
  return getCliEffortOptionsForProvider(client, defaultModel);
}

/** True only for transports that persist the generic CLI extension fields. */
export function usesCliTransport(form: Pick<HubCatEditorFormState, 'clientId' | 'acpEnabled'>): boolean {
  return (
    !form.acpEnabled &&
    (form.clientId === 'anthropic' ||
      form.clientId === 'openai' ||
      form.clientId === 'google' ||
      form.clientId === 'kimi' ||
      form.clientId === 'opencode')
  );
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
    client === 'opencode' ||
    client === 'acp'
  );
}

function legacyProfileClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.clientId) return profile.clientId;
  if (profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('kimi') || normalizedId.includes('moonshot')) return 'kimi';
  if (normalizedId.includes('opencode')) return 'opencode';
  if (normalizedId.includes('acp')) return 'acp';
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
  // F161: Generic ACP is a transport, not tied to any provider family.
  // Any account (oauth or api_key, any client family) can supply credentials to the ACP carrier.
  if (client === 'acp') return profiles;
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
  const voiceConfig = cat?.voiceConfig;
  const acpConfig = cat?.acp;
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
    colorPrimary: cat?.color.primary ?? createDraft?.templateColorPrimary ?? UNKNOWN_CAT_COLOR.primary,
    colorSecondary: cat?.color.secondary ?? createDraft?.templateColorSecondary ?? UNKNOWN_CAT_COLOR.secondary,
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
    cliEffort: persistedCliEffort ?? '',
    codexSpeed: cat?.cli?.serviceTier ?? '',
    codexCarrier: cat?.cli?.carrier ?? '',
    provider: cat?.provider ?? '',
    acpEnabled:
      Boolean(acpConfig) || (cat?.clientId as ClientId | undefined) === 'acp' || createDraft?.clientId === 'acp',
    acpTransport: (acpConfig?.transport as 'stdio' | 'httpstream' | undefined) ?? 'stdio',
    acpCommand:
      acpConfig?.command ??
      defaultAcpCommandForClient((cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic'),
    acpStartupArgs:
      acpConfig?.startupArgs?.join(' ') ??
      defaultAcpStartupArgsForClient(
        (cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic',
        (acpConfig?.transport as 'stdio' | 'httpstream' | undefined) ?? 'stdio',
      ),
    acpMaxLiveProcesses: acpConfig?.pool?.maxLiveProcesses !== undefined ? String(acpConfig.pool.maxLiveProcesses) : '',
    acpIdleTtlMinutes:
      acpConfig?.pool?.idleTtlMs !== undefined ? String(Math.round(acpConfig.pool.idleTtlMs / 60_000)) : '',
    mcpSupport:
      cat?.mcpSupport ??
      defaultMcpSupportForClient((cat?.clientId as ClientId | undefined) ?? createDraft?.clientId ?? 'anthropic'),
    sessionChain: String(cat?.sessionChain ?? true) as SessionChainValue,
    contextWindow: cat?.contextWindow ? String(cat.contextWindow) : '',
    voiceVoice: voiceStr(voiceConfig?.voice),
    voiceLangCode: voiceStr(voiceConfig?.langCode),
    voiceSpeed: voiceStr(voiceConfig?.speed),
    voiceRefAudio: voiceStr(voiceConfig?.refAudio),
    voiceRefText: voiceStr(voiceConfig?.refText),
    voiceInstruct: voiceStr(voiceConfig?.instruct),
    voiceTemperature: voiceStr(voiceConfig?.temperature),
  };
}

export function toStrategyForm(entry: CatStrategyEntry): StrategyFormState {
  return {
    strategy: entry.effective.strategy,
    statusStrategy: entry.effective.strategy,
    warnThreshold: String(entry.effective.thresholds.warn),
    actionThreshold: String(entry.effective.thresholds.action),
    maxCompressions: String(entry.effective.hybrid?.maxCompressions ?? 2),
    source: entry.source,
    revision: entry.revision ?? 'unknown',
    changedAt: entry.changedAt ?? 0,
    executionStatus: entry.executionStatus ?? {
      status: 'unavailable',
      missingCapabilities: ['managed_invocation_boundary'],
    },
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
    const maxCompressions = Number(strategy.maxCompressions);
    if (!Number.isInteger(maxCompressions) || maxCompressions <= 0) {
      throw new Error('Max Compressions 必须是正整数');
    }
    payload.hybrid = { maxCompressions };
  }
  return payload;
}

export {
  buildCodexConfigPatches,
  CODEX_APPROVAL_OPTIONS,
  CODEX_AUTH_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  type CodexApprovalPolicy,
  type CodexAuthMode,
  type CodexRuntimeSettings,
  type CodexSandboxMode,
  toCodexRuntimeSettings,
} from './hub-cat-editor.codex';
export {
  buildCatPatchPayload,
  buildCatPayload,
  hintModelFormatForClient,
  validateModelFormatForClient,
} from './hub-cat-editor.payload';
