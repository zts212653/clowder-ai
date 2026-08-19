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
  usesCliTransport,
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

/**
 * Parse the contextWindow form field.
 * clowder-ai#1208: empty or 0 = Auto (undefined), positive integer = Manual cap.
 */
export function buildContextWindow(form: HubCatEditorFormState): number | undefined {
  const raw = form.contextWindow.trim();
  if (raw.length === 0) return undefined;
  // Strict: reject non-integer inputs like "1.5", "12abc", "0xFF"
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('Context Window 必须是正整数（留空或 0 = Auto）');
  }
  const parsed = Number.parseInt(raw, 10);
  // 0 = Auto (same as empty).
  if (parsed === 0) return undefined;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Context Window 必须是正整数（留空或 0 = Auto）');
  }
  return parsed;
}

export interface CatPayloadContext {
  accountAuthType?: 'oauth' | 'api_key' | null;
  /** Rollback writes the original semantic value even when it matches the current read model. */
  forceServiceTier?: boolean;
}

export function buildCatPayload(form: HubCatEditorFormState, cat?: CatData | null, context: CatPayloadContext = {}) {
  const contextWindow = buildContextWindow(form);
  const hasExistingWindow = cat?.contextWindow != null;
  const contextWindowPatch =
    contextWindow !== undefined ? { contextWindow } : cat && hasExistingWindow ? { contextWindow: null as null } : {};
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
  const cliTransport = usesCliTransport(form);
  const trimmedCliEffort = trimText(form.cliEffort);
  const cliFields: Record<string, unknown> = {};
  if (cliTransport && trimmedCliEffort.length > 0) {
    cliFields.effort = trimmedCliEffort;
  } else if (cat?.cli?.effort) {
    cliFields.effort = null as null;
  }
  const nextServiceTier = form.codexSpeed ?? '';
  const currentServiceTier = cat?.cli?.serviceTier ?? '';
  const serviceTierEligible = form.clientId === 'openai' && context.accountAuthType === 'oauth' && !form.acpEnabled;
  if (serviceTierEligible && (context.forceServiceTier || nextServiceTier !== currentServiceTier)) {
    cliFields.serviceTier = nextServiceTier || (null as null);
  }
  // F254 D2: per-cat Codex carrier override. Only meaningful when the cat
  // actually dispatches through the local Codex CLI — generic ACP wins over
  // the carrier in the production assembly, so don't persist one under ACP.
  if (cliTransport && form.clientId === 'openai') {
    if (form.codexCarrier) {
      cliFields.carrier = form.codexCarrier;
    } else if (cat?.cli?.carrier) {
      cliFields.carrier = null as null;
    }
  }
  if (!cliTransport && cat?.cli?.carrier) {
    cliFields.carrier = null as null;
  }
  const cliPatch = Object.keys(cliFields).length > 0 ? { cli: cliFields } : {};
  const nextCliConfigArgs = (form.cliConfigArgs ?? []).filter((arg) => arg.trim().length > 0);
  const cliConfigArgsPatch = cliTransport
    ? { cliConfigArgs: nextCliConfigArgs }
    : cat?.cliConfigArgs?.length
      ? { cliConfigArgs: [] as string[] }
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
    ...contextWindowPatch,
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
    ...cliConfigArgsPatch,
    ...buildProviderPatch(form, cat),
  };
}

function normalizeOptionalText(value: unknown): string | null {
  const trimmed = trimText(value);
  return trimmed.length > 0 ? trimmed : null;
}

export function buildCatPatchPayload(form: HubCatEditorFormState, cat: CatData, context: CatPayloadContext = {}) {
  const payload = buildCatPayload(form, cat, context) as Record<string, unknown>;

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
