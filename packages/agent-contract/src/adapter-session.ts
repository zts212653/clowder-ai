import { z } from 'zod';

const nativeId = z
  .string()
  .min(1)
  .max(512)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Native identifiers cannot contain control characters.
  .regex(/^[^\s\x00-\x1f]+$/);
const message = z.string().max(8_192);

export const agentAdapterOpenResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    binding: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('bound'), nativeSessionId: nativeId }),
      z.strictObject({ state: z.literal('pending_first_input') }),
    ]),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['resume_unavailable', 'failed']),
    reason: message,
    identityStatus: z.enum(['stale', 'unverifiable']).optional(),
  }),
]);

const toolId = z.string().min(1).max(512);
const tokenCount = z.number().int().nonnegative().optional();
const adapterUsage = z.strictObject({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  totalTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  lastTurnInputTokens: tokenCount,
  contextUsedTokens: tokenCount,
  contextWindowSize: tokenCount,
  costUsd: z.number().nonnegative().optional(),
  costEstimated: z.boolean().optional(),
});
export const agentAdapterEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('native_bound'), nativeSessionId: nativeId }),
  z.strictObject({
    type: z.literal('output'),
    text: z.string(),
    textMode: z.enum(['append', 'replace']).default('append'),
  }),
  z.strictObject({ type: z.literal('status'), detail: message }),
  z.strictObject({ type: z.literal('tool_call'), callId: toolId, name: toolId, input: z.unknown().optional() }),
  z.strictObject({
    type: z.literal('tool_result'),
    callId: toolId,
    status: z.enum(['ok', 'error', 'unknown']),
    output: z.unknown().optional(),
  }),
  z.strictObject({ type: z.literal('error'), code: toolId, message, disposition: z.enum(['transient', 'terminal']) }),
  z.strictObject({
    type: z.literal('done'),
    outcome: z.enum(['completed', 'cancelled', 'failed']),
    errorCode: toolId.optional(),
    messageUsage: adapterUsage.optional(),
  }),
]);

export const agentAdapterCancelResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['unsupported', 'turn_ended', 'failed']) }),
]);

export const agentAdapterReleaseResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.literal('failed'), reason: message }),
]);
