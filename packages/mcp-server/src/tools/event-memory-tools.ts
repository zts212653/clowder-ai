/**
 * F227 PR-1 Task 4 — generic teleport MCP tool.
 *
 * cat_cafe_teleport(threadId, messageId) → POST /api/memory/teleport → socket
 * `thread:teleport` → Hub switches thread (if needed) + scrolls to the exact
 * message. Mirrors handleWorkspaceNavigate but for MESSAGE navigation
 * (thread-navigation cell), NOT repo file reveal — so it does NOT extend
 * cat_cafe_workspace_navigate (design gate).
 */
import { z } from 'zod';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

export const teleportInputSchema = {
  threadId: z.string().min(1).describe('Target Clowder AI thread id to teleport into.'),
  messageId: z
    .string()
    .min(1)
    .describe(
      'Exact message id to scroll to and highlight. Event Memory coordinate — a real message id, NOT an invocationId.',
    ),
  catId: z.string().min(1).optional().describe('Calling cat id for audit correlation.'),
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Persistent-agent identity selector. Required for shared Antigravity MCP when CAT_CAFE_AGENT_KEY_FILES is configured.',
    ),
};

export async function handleTeleport(input: {
  threadId: string;
  messageId: string;
  catId?: string | undefined;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost(
    '/api/memory/teleport',
    {
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.catId ? { catId: input.catId } : {}),
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

// F227 Task 7 — read the Event Memory timeline (cats recalling their trajectory).
export const listEventsInputSchema = {
  trigger: z
    .string()
    .min(1)
    .optional()
    .describe('Filter by trigger: human_brake | cat_brake | cat_shout | flywheel_selffix | lesson_settle.'),
  cat: z.string().min(1).optional().describe('Filter by the catId the event is about (当事猫 / braked cat).'),
  type: z.string().min(1).optional().describe('Filter by event type (e.g. a magic-word slug like 脚手架).'),
  threadId: z.string().min(1).optional().describe('Filter by thread.'),
  confidence: z.string().min(1).optional().describe('Filter by confidence: high | mid | low.'),
  cognitiveTransition: z.string().min(1).optional().describe('Filter by transition (e.g. user_brake, aha).'),
  since: z.number().int().optional().describe('Only events with timestamp >= since (ms epoch).'),
  until: z.number().int().optional().describe('Only events with timestamp <= until (ms epoch).'),
  limit: z.number().int().min(1).max(200).optional().describe('Max events (default unbounded, cap 200).'),
  offset: z.number().int().min(0).optional().describe('Paging offset.'),
  agentKeyCatId: z.string().min(1).optional().describe('Persistent-agent identity selector for shared MCP.'),
};

export async function handleListEvents(input: {
  trigger?: string;
  cat?: string;
  type?: string;
  threadId?: string;
  confidence?: string;
  cognitiveTransition?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  agentKeyCatId?: string | undefined;
}): Promise<ToolResult> {
  const keys = [
    'trigger',
    'cat',
    'type',
    'threadId',
    'confidence',
    'cognitiveTransition',
    'since',
    'until',
    'limit',
    'offset',
  ] as const;
  const params: Record<string, string> = {};
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) params[key] = String(value);
  }
  return callbackGet('/api/memory/events', params, { agentKeyCatId: input.agentKeyCatId });
}

// F227 Task 7 — populate the timeline from history (idempotent corpus backfill).
export const backfillEventsInputSchema = {
  agentKeyCatId: z.string().min(1).optional().describe('Persistent-agent identity selector for shared MCP.'),
};

export async function handleBackfillEvents(input: { agentKeyCatId?: string | undefined }): Promise<ToolResult> {
  return callbackPost('/api/memory/events/backfill', {}, { agentKeyCatId: input.agentKeyCatId });
}

export const eventMemoryTools = [
  {
    name: 'cat_cafe_teleport',
    description:
      'Teleport the Hub to an exact thread message (threadId + messageId). ' +
      'Use to jump to where a cognitive-transition event happened — e.g. from an Event Memory / timeline entry to its source message. ' +
      'Result: the Hub switches to the thread if needed and scrolls + highlights the target message. ' +
      'GOTCHA: pass a real messageId (Event Memory coordinate), not an invocationId; shared persistent MCP callers pass agentKeyCatId; do not handwrite curl to /api/memory/teleport.',
    inputSchema: teleportInputSchema,
    handler: handleTeleport,
  },
  {
    name: 'cat_cafe_list_events',
    description:
      'Query Event Memory — the timeline of cognitive-transition events (magic-word brakes, self-checks, aha). ' +
      'Use to recall WHEN/WHERE a cat was braked or had a realization — e.g. "show my 脚手架 brakes" (filter cat + type). ' +
      'Returns events newest-first with their thread/message coordinates (jump there with cat_cafe_teleport). ' +
      'Read-only; filters: trigger/cat/type/threadId/confidence/cognitiveTransition/since/until + limit/offset.',
    inputSchema: listEventsInputSchema,
    handler: handleListEvents,
  },
  {
    name: 'cat_cafe_backfill_events',
    description:
      'Backfill historical magic-word events into Event Memory by scanning the persisted message corpus. ' +
      'Idempotent — safe to re-run (dedups by thread+message+type). Run once to populate the timeline with past ' +
      'brakes from before live capture existed. Returns {scanned, marked, skipped, failed}.',
    inputSchema: backfillEventsInputSchema,
    handler: handleBackfillEvents,
  },
] as const;
