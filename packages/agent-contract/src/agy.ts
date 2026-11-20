import { z } from 'zod';

const stepState = z.enum(['ACTIVE', 'DONE', 'ERROR', 'UNKNOWN']);
const anomaly = z.object({
  kind: z.enum([
    'unknown_step_state',
    'missing_result_response',
    'unknown_event',
    'unknown_step_type',
    'invalid_step_identity',
    'invalid_tool_identity',
    'invalid_tool_evidence',
    'invalid_result_evidence',
    'invalid_denial_evidence',
  ]),
  detail: z.string(),
});
const usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  thinkingTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
});
const denial = z.object({ action: z.string(), displayName: z.string() });
const toolCall = z.object({
  stepIndex: z.number(),
  state: stepState,
  rawState: z.string(),
  toolName: z.string(),
  parameters: z.record(z.unknown()),
  output: z.string(),
  errorMessage: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  completedOnce: z.literal(true).optional(),
});
const step = z.object({
  kind: z.literal('step'),
  conversationId: z.string(),
  stepIndex: z.number(),
  state: stepState,
  rawState: z.string(),
  stepType: z.string(),
  anonymousCompletion: z.literal(true).optional(),
  textDelta: z.string().nullable(),
  toolName: z.string().nullable(),
  toolParameters: z.record(z.unknown()).nullable(),
  toolOutput: z.string().nullable(),
  toolErrorMessage: z.string().nullable(),
  anomalies: z.array(anomaly),
  durationSeconds: z.number().nullable(),
  usage: usage.nullable(),
});

export const agentAccessAgyTurnSchema = z.object({
  conversationId: z.string().nullable(),
  firstStepIndex: z.number().nullable(),
  lastStepIndex: z.number().nullable(),
  finalText: z.string(),
  toolCalls: z.array(toolCall),
  stepsComplete: z.boolean(),
  unconfirmedStepIndices: z.array(z.number()),
  deniedActions: z.array(denial),
  usage,
  turnUsage: usage.nullable(),
  lastTurnInputTokens: z.number().nullable(),
  upstreamStatus: z.string().nullable(),
  upstreamError: z.string().nullable(),
  sessionTurnCount: z.number(),
  completedResponseStep: z.number().nullable(),
  completedCompactionStep: z.number().nullable(),
  recoveredErrorSteps: z.array(z.number()),
  outcome: z.enum(['ok', 'unconfirmed', 'denied', 'protocol_error', 'error', 'empty', 'incomplete']),
  diagnosis: z.string(),
  unknownEvents: z.array(z.string()),
  anomalies: z.array(anomaly),
});

export const agentAccessAgyFrameSchema = z.object({
  sequence: z.number().int().nonnegative(),
  step: step.optional(),
});

export const agentAccessAgyTurnRequestSchema = z.object({
  lines: z.array(z.string()),
  terminalPolicyRejected: z.boolean(),
});
