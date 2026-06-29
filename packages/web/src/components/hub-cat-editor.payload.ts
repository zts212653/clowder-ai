import type { CatData } from '@/hooks/useCatData';
import {
  type ClientId,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  defaultAcpCommandForClient,
  defaultAcpStartupArgsForClient,
  type HubCatEditorFormState,
  normalizeMentionPattern,
  splitCommandArgs,
  splitMentionPatterns,
  splitStrengthTags,
} from './hub-cat-editor.model';

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function usesOpenCodeProvider(form: HubCatEditorFormState): boolean {
  // F161: the `provider` field is an OpenCode-only concept — it selects the env-map template
  // (BUILTIN_ENV_MAPS[provider]) for OpenCode's multi-provider backend routing. Generic ACP
  // carriers (clientId='acp') are NOT provider carriers: the field renders only for opencode
  // (there is no UI to set it for acp), BUILTIN_ENV_MAPS has no 'acp' entry, and env
  // customization flows through the account's envVars templates (env-map priority 1). A stale
  // provider on a generic ACP member (e.g. migrated from clientId='opencode') is therefore
  // cleared on save by the !providerCarrier branch below — not preserved. For OpenCode
  // provider management, use clientId='opencode' (cli or acp transport).
  return form.clientId === 'opencode';
}

function buildProviderPatch(form: HubCatEditorFormState, cat?: CatData | null): Record<string, unknown> {
  const providerCarrier = usesOpenCodeProvider(form);
  const trimmedProvider = trimText(form.provider);
  if (providerCarrier && trimmedProvider.length > 0) return { provider: trimmedProvider };
  if (cat?.provider && (form.clientId === 'opencode' || !providerCarrier)) return { provider: null as null };
  return {};
}

/**
 * Returns a hint string when the model does not follow "providerId/modelId" convention for opencode.
 * Advisory only — callers should display as a warning, not block submission.
 */
export function hintModelFormatForClient(client: ClientId, model: string): string | null {
  if (client !== 'opencode') return null;
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) return null;
  return 'OpenCode 建议使用 providerId/modelId 格式（例如 openai/gpt-5.4）';
}

/** @deprecated Use {@link hintModelFormatForClient} — kept for backward compatibility. */
export const validateModelFormatForClient = hintModelFormatForClient;

function resolveFormAccountRef(form: HubCatEditorFormState): string {
  return trimText(form.accountRef);
}

function buildVoiceConfig(form: HubCatEditorFormState) {
  const voice = trimText(form.voiceVoice);
  const langCode = trimText(form.voiceLangCode);
  if (!voice) return undefined;
  if (!langCode) return undefined;
  const speed = Number.parseFloat(form.voiceSpeed);
  const temperature = Number.parseFloat(form.voiceTemperature);
  return {
    voice,
    langCode,
    ...(Number.isFinite(speed) && speed > 0 ? { speed } : {}),
    ...(trimText(form.voiceRefAudio) ? { refAudio: trimText(form.voiceRefAudio) } : {}),
    ...(trimText(form.voiceRefText) ? { refText: trimText(form.voiceRefText) } : {}),
    ...(trimText(form.voiceInstruct) ? { instruct: trimText(form.voiceInstruct) } : {}),
    ...(Number.isFinite(temperature) && temperature >= 0 ? { temperature } : {}),
  };
}

function optionalPositiveInteger(raw: string, fieldName: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    throw new Error(`${fieldName} 必须是正整数`);
  }
  return parsed;
}

const ACP_FORM_OWNED_KEYS = new Set(['command', 'startupArgs', 'transport', 'pool']);

function preserveHiddenAcpFields(cat?: CatData | null): Record<string, unknown> {
  if (!cat?.acp) return {};
  return Object.fromEntries(Object.entries(cat.acp).filter(([key]) => !ACP_FORM_OWNED_KEYS.has(key)));
}

function buildAcpTransportConfig(form: HubCatEditorFormState, cat?: CatData | null) {
  const transport = form.acpTransport ?? 'stdio';
  const command = trimText(form.acpCommand) || defaultAcpCommandForClient(form.clientId);
  if (!command) throw new Error('ACP Command 不能为空');
  const startupArgs = splitCommandArgs(
    trimText(form.acpStartupArgs) || defaultAcpStartupArgsForClient(form.clientId, transport),
  );
  if (startupArgs.length === 0) throw new Error('ACP Startup Args 不能为空');
  const maxLiveProcesses = optionalPositiveInteger(form.acpMaxLiveProcesses, 'ACP Max Processes');
  const idleTtlMinutes = optionalPositiveInteger(form.acpIdleTtlMinutes, 'ACP Idle TTL');
  const pool =
    maxLiveProcesses !== undefined || idleTtlMinutes !== undefined
      ? {
          ...(maxLiveProcesses !== undefined ? { maxLiveProcesses } : {}),
          ...(idleTtlMinutes !== undefined ? { idleTtlMs: idleTtlMinutes * 60_000 } : {}),
        }
      : undefined;
  return {
    ...preserveHiddenAcpFields(cat),
    command,
    startupArgs,
    // F161 Phase C: include transport only when non-default (httpstream)
    ...(transport !== 'stdio' ? { transport } : {}),
    ...(pool ? { pool } : {}),
  };
}

function buildAcpPatch(form: HubCatEditorFormState, cat?: CatData | null): Record<string, unknown> {
  if (form.clientId === 'antigravity') return cat?.acp ? { acp: null } : {};
  if (form.acpEnabled) return { acp: buildAcpTransportConfig(form, cat) };
  return cat?.acp ? { acp: null } : {};
}

export function buildContextBudget(form: HubCatEditorFormState) {
  const values = [form.maxPromptTokens, form.maxContextTokens, form.maxMessages, form.maxContentLengthPerMsg].map(
    (value) => value.trim(),
  );
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

export function buildCatPayload(form: HubCatEditorFormState, cat?: CatData | null) {
  const contextBudget = buildContextBudget(form);
  const hasExistingBudget = Boolean(cat?.contextBudget);
  const contextBudgetPatch =
    contextBudget !== undefined ? { contextBudget } : cat && hasExistingBudget ? { contextBudget: null as null } : {};
  const name = trimText(form.name);
  const displayName = trimText(form.displayName) || name;
  const createName = name || displayName;
  const updateName = name || displayName || cat?.name || cat?.displayName || '';
  const trimmedAccountRef = resolveFormAccountRef(form);
  const accountRefPatch =
    trimmedAccountRef.length > 0
      ? { accountRef: trimmedAccountRef }
      : cat?.accountRef
        ? { accountRef: null as null }
        : {};
  // #712: always send the form's mcpSupport value so the user can toggle it explicitly
  const mcpSupportPatch = { mcpSupport: form.mcpSupport };
  const trimmedCliEffort = trimText(form.cliEffort);
  const cliPatch =
    trimmedCliEffort.length > 0
      ? { cli: { effort: trimmedCliEffort } }
      : cat?.cli?.effort
        ? { cli: { effort: null as null } }
        : {};
  const voiceConfig = buildVoiceConfig(form);
  const voiceConfigPatch: Record<string, unknown> =
    voiceConfig !== undefined ? { voiceConfig } : cat?.voiceConfig ? { voiceConfig: null } : {};
  const common = {
    displayName,
    variantLabel: trimText(form.variantLabel),
    nickname: trimText(form.nickname),
    avatar: trimText(form.avatar),
    color: {
      primary: trimText(form.colorPrimary),
      secondary: trimText(form.colorSecondary),
    },
    mentionPatterns: Array.from(
      new Set(splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean)),
    ),
    roleDescription: trimText(form.roleDescription),
    personality: trimText(form.personality),
    teamStrengths: trimText(form.teamStrengths),
    caution: trimText(form.caution) || null,
    strengths: splitStrengthTags(form.strengths),
    sessionChain: form.sessionChain === 'true',
    ...contextBudgetPatch,
    ...voiceConfigPatch,
    ...buildAcpPatch(form, cat),
  };

  if (form.clientId === 'antigravity') {
    const commandArgsSource = trimText(form.commandArgs) || DEFAULT_ANTIGRAVITY_COMMAND_ARGS;
    return {
      ...common,
      ...(cat ? { name: updateName } : { catId: trimText(form.catId), name: createName }),
      clientId: 'antigravity' as const,
      ...accountRefPatch,
      ...mcpSupportPatch,
      defaultModel: trimText(form.defaultModel),
      commandArgs: splitCommandArgs(commandArgsSource),
    };
  }

  return {
    ...common,
    ...(cat ? { name: updateName } : { catId: trimText(form.catId), name: createName }),
    clientId: form.clientId,
    ...accountRefPatch,
    ...mcpSupportPatch,
    ...cliPatch,
    defaultModel: trimText(form.defaultModel),
    cliConfigArgs: (form.cliConfigArgs ?? []).filter((arg) => arg.trim().length > 0),
    ...buildProviderPatch(form, cat),
  };
}

function normalizeOptionalText(value: unknown): string | null {
  const trimmed = trimText(value);
  return trimmed.length > 0 ? trimmed : null;
}

export function buildCatPatchPayload(form: HubCatEditorFormState, cat: CatData) {
  const payload = buildCatPayload(form, cat) as Record<string, unknown>;

  if (form.clientId === cat.clientId) {
    delete payload.clientId;
  }
  if (trimText(form.defaultModel) === trimText(cat.defaultModel)) {
    delete payload.defaultModel;
  }

  const nextAccountRef = normalizeOptionalText(form.accountRef);
  const currentAccountRef = normalizeOptionalText(cat.accountRef);
  if (nextAccountRef === currentAccountRef) {
    delete payload.accountRef;
  }

  const nextProvider =
    usesOpenCodeProvider(form) && trimText(form.provider).length > 0 ? trimText(form.provider) : null;
  const currentProvider = normalizeOptionalText(cat.provider);
  if (nextProvider === currentProvider) {
    delete payload.provider;
  }

  // #712: skip mcpSupport when it hasn't changed
  if (form.mcpSupport === (cat.mcpSupport ?? true)) {
    delete payload.mcpSupport;
  }

  return payload;
}
