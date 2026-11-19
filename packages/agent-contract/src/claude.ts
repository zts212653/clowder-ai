import type { CatId } from '@cat-cafe/shared';
import { z } from 'zod';

export const agentAccessClaudeMessageSchema = z.object({
  type: z.enum(['agent_loop', 'text', 'system_info', 'session_init', 'provider_signal', 'tool_use', 'error']),
  catId: z.string().min(1),
  timestamp: z.number(),
  content: z.string().optional(),
  textSource: z.literal('provider_summary').optional(),
  sessionId: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.record(z.unknown()).optional(),
  toolUseId: z.string().optional(),
  error: z.string().optional(),
  errorDisposition: z.literal('transient').optional(),
  contextCompaction: z
    .object({
      eventSource: z.literal('claude_compact_boundary'),
      preTokens: z.number().optional(),
    })
    .optional(),
});

export const agentAccessClaudeUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  cacheCreation5mTokens: z.number().optional(),
  cacheCreation1hTokens: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  durationApiMs: z.number().optional(),
  numTurns: z.number().optional(),
  contextWindowSize: z.number().optional(),
  lastTurnInputTokens: z.number().optional(),
});

export type AgentAccessClaudeWireMessage = z.infer<typeof agentAccessClaudeMessageSchema>;
export type AgentAccessClaudeMessage = Omit<AgentAccessClaudeWireMessage, 'catId'> & { catId: CatId };
export type AgentAccessClaudeUsage = z.infer<typeof agentAccessClaudeUsageSchema>;

export const agentAccessClaudeFrameSchema = z.object({ sequence: z.number().int().nonnegative(), event: z.unknown() });

export const agentAccessClaudeProjectionSchema = z.object({
  sequence: z.number().int().nonnegative(),
  messages: z.union([agentAccessClaudeMessageSchema, z.array(agentAccessClaudeMessageSchema)]).nullable(),
  usage: agentAccessClaudeUsageSchema.optional(),
});

export type AgentAccessClaudeProjection = z.infer<typeof agentAccessClaudeProjectionSchema>;

export const agentAccessClaudeBatchSchema = z.object({
  catId: z.string().min(1),
  mode: z.enum(['transcript', 'hook']),
  entries: z.array(z.unknown()),
  lastTextMessageId: z.string().optional(),
});
export const agentAccessClaudeBatchResultSchema = z.object({
  frames: z.array(z.object({ index: z.number().int().nonnegative(), message: agentAccessClaudeMessageSchema })),
  lastTextMessageId: z.string().optional(),
});
