import type { CatData } from '@/hooks/useCatData';
import {
  type ClientValue,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  type HubCatEditorFormState,
  normalizeMentionPattern,
  splitCommandArgs,
  splitMentionPatterns,
  splitStrengthTags,
} from './hub-cat-editor.model';
import { defaultMcpSupportForClient } from './hub-cat-editor.protocols';

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns a hint string when the model does not follow "providerId/modelId" convention for opencode.
 * Advisory only — callers should display as a warning, not block submission.
 */
export function hintModelFormatForClient(client: ClientValue, model: string): string | null {
  if (client !== 'opencode') return null;
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) return null;
  return 'OpenCode 建议使用 providerId/modelId 格式（例如 openai/gpt-5.4）';
}

/** @deprecated Use {@link hintModelFormatForClient} — kept for backward compatibility. */
export const validateModelFormatForClient = hintModelFormatForClient;

function resolveFormAccountRef(form: HubCatEditorFormState): string {
  return trimText(
    form.accountRef ?? (form as HubCatEditorFormState & { providerProfileId?: string }).providerProfileId,
  );
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
      new Set(splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean)),
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
    ...(trimText(form.ocProviderName)
      ? { ocProviderName: trimText(form.ocProviderName) }
      : cat?.ocProviderName
        ? { ocProviderName: null as null }
        : {}),
  };
}
