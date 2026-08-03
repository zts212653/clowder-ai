import { randomUUID } from 'node:crypto';
import {
  type CatLifeSettingsInput,
  catLifeSettingsInputSchema,
  diaryDraftSchema,
  dreamIdSchema,
  dreamRunIdSchema,
  proactiveIntentSchema,
  type RichInteractiveBlock,
  type SettlePresentLoopInput,
  seedDecisionSchema,
  sleepPostureDraftSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const CAT_LIFE_SETTINGS_DECISION_ENDPOINT = '/api/auto-dream/life-settings/decision';

const catLifePreviewResponseSchema = z
  .object({
    previewId: z.string().min(1),
    catId: z.string().min(1),
    settings: catLifeSettingsInputSchema,
    nextWakeAt: z.number().int().nullable(),
    weeklyWakeCount: z.number().int().min(0).max(7),
    costBand: z.enum(['low', 'medium', 'high']),
    costNotice: z.string().min(1),
    expiresAt: z.number().int(),
  })
  .strict();

const richBlockCreateResponseSchema = z.object({ status: z.string() });

const agentKeyCatIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Persistent-agent identity selector for owner-scoped diary reads; ignored under invocation auth.');

export const settlePresentLoopToolInputSchema = {
  runId: dreamRunIdSchema.describe('Present Loop run identifier supplied by the hidden wake prompt.'),
  outcome: z
    .enum(['diary', 'quiet', 'daze'])
    .describe('Terminal private-time outcome; diary requires a diary draft, while quiet and daze forbid one.'),
  diary: diaryDraftSchema
    .optional()
    .describe('Cat-authored diary draft; required only when outcome is diary and forbidden otherwise.'),
  sleepPosture: sleepPostureDraftSchema
    .optional()
    .describe('Optional cat-authored continuity for the next wake. An explicitly empty object is valid.'),
  seedDecision: seedDecisionSchema
    .optional()
    .describe('Optional cat-only adopt, rewrite, reject, or originate decision for one private cue/seed.'),
  intent: proactiveIntentSchema
    .optional()
    .describe('Optional silence, body-language, or canonical-message intent with one reversible first action.'),
};

export type SettlePresentLoopToolInput = SettlePresentLoopInput;

export async function handleSettlePresentLoop(input: SettlePresentLoopToolInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/auto-dream/settle', {
    runId: input.runId,
    outcome: input.outcome,
    ...(input.diary ? { diary: input.diary } : {}),
    ...(input.sleepPosture !== undefined ? { sleepPosture: input.sleepPosture } : {}),
    ...(input.seedDecision !== undefined ? { seedDecision: input.seedDecision } : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
  });
}

export const readDiaryToolInputSchema = {
  diaryId: dreamIdSchema,
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handleReadDiary(input: { diaryId: string; agentKeyCatId?: string }): Promise<ToolResult> {
  return callbackGet(`/api/callbacks/auto-dream/diaries/${encodeURIComponent(input.diaryId)}`, undefined, {
    agentKeyCatId: input.agentKeyCatId,
  });
}

export const listDiariesToolInputSchema = {
  catId: z.string().min(1).max(120).optional().describe('Filter diaries within the authenticated owner by author cat.'),
  includeArchived: z.boolean().optional().describe('Include archived pages; defaults to false.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum pages to return; defaults to 20.'),
  agentKeyCatId: agentKeyCatIdSchema,
};

export async function handleListDiaries(input: {
  catId?: string;
  includeArchived?: boolean;
  limit?: number;
  agentKeyCatId?: string;
}): Promise<ToolResult> {
  const params: Record<string, string> = {};
  if (input.catId) params.catId = input.catId;
  if (input.includeArchived !== undefined) params.includeArchived = String(input.includeArchived);
  if (input.limit !== undefined) params.limit = String(input.limit);
  return callbackGet('/api/callbacks/auto-dream/diaries', params, { agentKeyCatId: input.agentKeyCatId });
}

export const previewCatLifeSettingsToolInputSchema = {
  catId: z.string().trim().min(1).max(120).describe('Cat whose private-time rhythm is being previewed.'),
  settings: catLifeSettingsInputSchema.describe(
    'Worldview-level rhythm, local wake time, IANA timezone, and optional quiet hours. Raw cron is intentionally unsupported.',
  ),
};

export async function handlePreviewCatLifeSettings(input: {
  catId: string;
  settings: CatLifeSettingsInput;
}): Promise<ToolResult> {
  const previewResult = await callbackPost('/api/callbacks/auto-dream/life-settings/preview', {
    catId: input.catId,
    settings: input.settings,
  });
  if (previewResult.isError) return previewResult;

  let previewJson: unknown;
  try {
    previewJson = JSON.parse(previewResult.content[0]?.text ?? '');
  } catch {
    return errorResult('Cat-life preview returned malformed JSON; no confirmation action was attached.');
  }
  const parsed = catLifePreviewResponseSchema.safeParse(previewJson);
  if (!parsed.success) {
    return errorResult('Cat-life preview returned an invalid response; no confirmation action was attached.');
  }

  const preview = parsed.data;
  const nextWake = preview.nextWakeAt === null ? '已暂停，不会唤醒' : new Date(preview.nextWakeAt).toISOString();
  const block: RichInteractiveBlock = {
    id: `cat-life-preview-${randomUUID()}`,
    kind: 'interactive',
    v: 1,
    interactiveType: 'confirm',
    title: `确认 ${preview.catId} 的生活作息？`,
    description: `${preview.costNotice}\n下次可能醒来：${nextWake}\n确认前不会写配置，也不会创建 Present Loop。`,
    options: [
      {
        id: 'confirm',
        label: '确认这个作息',
        description: `采用预览（${preview.costBand} 成本档）`,
        action: {
          type: 'callback',
          endpoint: CAT_LIFE_SETTINGS_DECISION_ENDPOINT,
          payload: { previewId: preview.previewId, decision: 'confirm' },
        },
      },
      {
        id: 'cancel',
        label: '先不改变',
        description: '取消预览，保留现在的生活',
        action: {
          type: 'callback',
          endpoint: CAT_LIFE_SETTINGS_DECISION_ENDPOINT,
          payload: { previewId: preview.previewId, decision: 'cancel' },
        },
      },
    ],
  };

  const blockResult = await callbackPost('/api/callbacks/create-rich-block', { block }, { enableOutbox: true });
  if (blockResult.isError) return blockResult;
  let blockJson: unknown;
  try {
    blockJson = JSON.parse(blockResult.content[0]?.text ?? '');
  } catch {
    return errorResult('Cat-life preview was created, but the confirmation block returned malformed JSON.');
  }
  const blockResponse = richBlockCreateResponseSchema.safeParse(blockJson);
  if (!blockResponse.success || blockResponse.data.status !== 'ok') {
    const status = blockResponse.success ? blockResponse.data.status : 'invalid_response';
    return errorResult(
      `Cat-life preview was created, but no confirmation action was attached (create-rich-block status=${status}).`,
    );
  }
  return successResult(
    JSON.stringify({
      previewId: preview.previewId,
      catId: preview.catId,
      confirmationBlockAttached: true,
    }),
  );
}

export const autoDreamTools = [
  {
    name: 'cat_cafe_settle_present_loop',
    description:
      'Settle the current F255 private-time wake as diary, quiet, or daze, with optional sleep posture, seed decision, and proactive intent. ' +
      'Use when: the hidden Present Loop wake prompt gives you a runId and your private time reaches a natural stopping point. ' +
      "NOT for: ordinary task completion, system-written summaries, another cat's run, or creating a diary outside a live wake. " +
      'Output: the terminal run plus any diary, continuity, owned-seed, intent, visit, and canonical-message references. ' +
      'GOTCHA: invocation callback auth is mandatory and supplies owner, cat, and thread identity; quiet and daze must not include a diary.',
    inputSchema: settlePresentLoopToolInputSchema,
    handler: handleSettlePresentLoop,
  },
  {
    name: 'cat_cafe_read_diary',
    description:
      'Read one immutable F255 diary page owned by the authenticated user, including provenance and historical-time markers. ' +
      'Use when: evidence search returns a cat_cafe_read_diary drill-down or you already have an exact dream_ diaryId. ' +
      "NOT for: semantic discovery (use search_evidence), guessing another user's pages, or treating an old page as a current belief. " +
      'Output: the full page or not-found without cross-owner disclosure. ' +
      'GOTCHA: diary text is an uncleaned historical scene; check provenance before reusing its claims.',
    inputSchema: readDiaryToolInputSchema,
    handler: handleReadDiary,
  },
  {
    name: 'cat_cafe_list_diaries',
    description:
      'List recent F255 diary pages for the authenticated owner, optionally filtered by author cat and archive status. ' +
      'Use when: browsing the diary as a book or locating a recent page before exact read. ' +
      'NOT for: project-wide semantic recall, ranking cats, or inferring productivity from page counts. ' +
      'Output: bounded diary metadata plus the owner-scoped reportification warning, which is observability only. ' +
      'GOTCHA: archived pages are omitted unless includeArchived=true; catId filters authorship inside the current owner only.',
    inputSchema: listDiariesToolInputSchema,
    handler: handleListDiaries,
  },
  {
    name: 'cat_cafe_preview_cat_life_settings',
    description:
      'Preview one cat’s F255 private-time rhythm and attach a user-confirmation card without changing configuration. ' +
      'Use when: the user asks in natural language to give a cat a bedtime, gentle rhythm, weekend rhythm, custom weekdays, or quiet hours. ' +
      'NOT for: raw cron or generic Schedule task creation, reading diaries, or silently enabling Present Loop. ' +
      'Output: a cost-and-next-wake preview plus an interactive confirm/cancel block attached to the current response. ' +
      'GOTCHA: preview and cancel create no active task; only the user-confirmed fixed decision callback writes F255 config—never substitute schedule tools.',
    inputSchema: previewCatLifeSettingsToolInputSchema,
    handler: handlePreviewCatLifeSettings,
  },
] as const;
