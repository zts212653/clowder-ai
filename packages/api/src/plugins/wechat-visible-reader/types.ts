import { z } from 'zod';

export const weChatVisibleErrorCodeSchema = z.enum([
  'authorization_required',
  'permission_denied',
  'wechat_not_running',
  'no_active_conversation',
  'layout_not_recognized',
  'ocr_low_confidence',
  'capture_failed',
  'session_locked',
  'search_layout_not_recognized',
  'contact_not_found',
  'contact_ambiguous',
  'header_mismatch',
  'restore_failed',
  'navigation_failed',
]);

export type WeChatVisibleErrorCode = z.infer<typeof weChatVisibleErrorCodeSchema>;

export const normalizedRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .superRefine((rect, context) => {
    if (rect.x + rect.width > 1.000_001) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'rect exceeds horizontal bounds' });
    }
    if (rect.y + rect.height > 1.000_001) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'rect exceeds vertical bounds' });
    }
  });

export type NormalizedRect = z.infer<typeof normalizedRectSchema>;

const visibleUnitBase = z.object({
  bbox: normalizedRectSchema,
  ocrConfidence: z.number().min(0).max(1),
  layoutConfidence: z.number().min(0).max(1),
  presumedSender: z.enum(['self', 'other', 'unknown']),
  blockHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

const completeTextUnitSchema = visibleUnitBase
  .extend({
    blockType: z.literal('text'),
    isPartial: z.literal(false),
    text: z.string().min(1),
  })
  .strict();

const partialTextUnitSchema = visibleUnitBase
  .extend({
    blockType: z.literal('text'),
    isPartial: z.literal(true),
    text: z.null(),
    indicator: z.literal('partial_text_omitted'),
  })
  .strict();

export const nonTextIndicatorSchema = z.enum([
  'image_placeholder',
  'voice_placeholder',
  'red_packet',
  'quote_placeholder',
  'other_known',
]);

const nonTextUnitSchema = visibleUnitBase
  .extend({
    blockType: z.literal('non_textual'),
    isPartial: z.literal(false),
    indicator: nonTextIndicatorSchema,
  })
  .strict();

export const visibleMessageUnitSchema = z.union([completeTextUnitSchema, partialTextUnitSchema, nonTextUnitSchema]);

export type VisibleMessageUnit = z.infer<typeof visibleMessageUnitSchema>;

export const weChatVisibleFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: weChatVisibleErrorCodeSchema,
        userAction: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

export type WeChatVisibleFailure = z.infer<typeof weChatVisibleFailureSchema>;

const windowSizeSchema = z
  .object({
    width: z.number().positive().max(20_000),
    height: z.number().positive().max(20_000),
  })
  .strict();

export const weChatVisibleProbeSuccessSchema = z
  .object({
    ok: z.literal(true),
    wechatVersion: z.string().min(1).max(64),
    profileId: z.string().min(1).max(128),
    windowSize: windowSizeSchema,
  })
  .strict();

export const weChatVisibleProbeResultSchema = z.union([weChatVisibleProbeSuccessSchema, weChatVisibleFailureSchema]);

export type WeChatVisibleProbeResult = z.infer<typeof weChatVisibleProbeResultSchema>;

export const weChatNavigationRestoreSchema = z
  .object({
    conversationRestored: z.boolean(),
    scrollAnchorRestored: z.boolean(),
    frontApplicationRestored: z.boolean(),
  })
  .strict();

export const weChatNavigationSpikeSuccessSchema = z
  .object({
    ok: z.literal(true),
    targetHeaderMatched: z.literal(true),
    restore: weChatNavigationRestoreSchema,
  })
  .strict();

export const weChatNavigationSpikeResultSchema = z.union([
  weChatNavigationSpikeSuccessSchema,
  weChatVisibleFailureSchema,
]);

export type WeChatNavigationSpikeResult = z.infer<typeof weChatNavigationSpikeResultSchema>;

export const weChatVisibleSuccessSchema = z
  .object({
    ok: z.literal(true),
    captureId: z.string().min(1).max(128),
    capturedAt: z.string().datetime({ offset: true }),
    source: z
      .object({
        bundleId: z.literal('com.tencent.xinWeChat'),
        wechatVersion: z.string().min(1).max(64),
        windowSize: windowSizeSchema,
      })
      .strict(),
    layout: z
      .object({
        profileId: z.string().min(1).max(128),
        confidence: z.number().min(0).max(1),
        bodyRegion: normalizedRectSchema,
      })
      .strict(),
    messageUnits: z.array(visibleMessageUnitSchema),
    totalChars: z.number().int().nonnegative(),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(512)).max(20),
  })
  .strict();

export type WeChatVisibleSuccess = z.infer<typeof weChatVisibleSuccessSchema>;

export const weChatVisibleReadResultSchema = z.union([weChatVisibleSuccessSchema, weChatVisibleFailureSchema]);

export type WeChatVisibleReadResult = z.infer<typeof weChatVisibleReadResultSchema>;

export const weChatConversationRecentSuccessSchema = weChatVisibleSuccessSchema
  .extend({
    targetHeader: z.string().min(1).max(128),
    targetHeaderMatched: z.literal(true),
    restore: weChatNavigationRestoreSchema,
  })
  .strict();

export const weChatConversationRecentFailureSchema = weChatVisibleFailureSchema
  .extend({
    restore: weChatNavigationRestoreSchema.optional(),
  })
  .strict();

export const weChatConversationRecentResultSchema = z.union([
  weChatConversationRecentSuccessSchema,
  weChatConversationRecentFailureSchema,
]);

export type WeChatConversationRecentResult = z.infer<typeof weChatConversationRecentResultSchema>;

export interface WeChatVisibleResultLimits {
  maxBlocks: number;
  maxChars: number;
}

export function parseWeChatVisibleReadResult(
  input: unknown,
  limits: WeChatVisibleResultLimits,
): WeChatVisibleReadResult {
  const parsed = weChatVisibleReadResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('invalid native result');
  }

  const result = parsed.data;
  if (!result.ok) return result;

  validateReadSuccess(result, limits);
  return result;
}

function validateReadSuccess(result: WeChatVisibleSuccess, limits: WeChatVisibleResultLimits): void {
  if (result.messageUnits.length > limits.maxBlocks || result.totalChars > limits.maxChars) {
    throw new Error('native result exceeds requested limits');
  }

  const returnedTextChars = result.messageUnits.reduce((total, unit) => {
    if (unit.blockType !== 'text' || unit.isPartial) return total;
    return total + [...unit.text].length;
  }, 0);
  if (returnedTextChars !== result.totalChars || returnedTextChars > limits.maxChars) {
    throw new Error('native text character count is invalid');
  }
}

export function parseWeChatVisibleProbeResult(input: unknown): WeChatVisibleProbeResult {
  const parsed = weChatVisibleProbeResultSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid native probe result');
  return parsed.data;
}

export function parseWeChatNavigationSpikeResult(input: unknown): WeChatNavigationSpikeResult {
  const parsed = weChatNavigationSpikeResultSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid native navigation spike result');
  return parsed.data;
}

export function parseWeChatConversationRecentResult(
  input: unknown,
  limits: WeChatVisibleResultLimits,
): WeChatConversationRecentResult {
  const parsed = weChatConversationRecentResultSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid native recent-conversation result');
  if (parsed.data.ok) validateReadSuccess(parsed.data, limits);
  return parsed.data;
}
