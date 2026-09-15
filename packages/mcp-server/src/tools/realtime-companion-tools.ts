import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('realtime-companion-tools.ts', undefined, {
  resourceFamily: 'audio',
  authority: 'local-runtime',
});

const ADMISSION_REF = 'file:docs/features/F306-codex-app-capability-parity.md' as const;

export const realtimeCompanionStartInputSchema = {
  thread_id: z.string().trim().min(1).describe('Existing Clowder AI thread bound to the current native cat session'),
  consumer: z
    .enum(['watch_video', 'meeting_companion'])
    .describe('Named experimental journey; arbitrary realtime or raw-host consumers are not accepted'),
};

export const realtimeCompanionStatusInputSchema = {
  thread_id: z.string().trim().min(1).describe('Clowder AI thread whose current-cat companion status should be read'),
};

export const realtimeCompanionStopInputSchema = realtimeCompanionStatusInputSchema;

type StartInput = {
  thread_id: string;
  consumer: 'watch_video' | 'meeting_companion';
};

export async function handleRealtimeCompanionStart(input: StartInput): Promise<ToolResult> {
  return companionRequest(input.thread_id, '/start', {
    method: 'POST',
    body: JSON.stringify({ consumer: input.consumer, experimental: true }),
  });
}

export async function handleRealtimeCompanionStatus(input: { thread_id: string }): Promise<ToolResult> {
  return companionRequest(input.thread_id, '/status');
}

export async function handleRealtimeCompanionStop(input: { thread_id: string }): Promise<ToolResult> {
  return companionRequest(input.thread_id, '/stop', { method: 'POST' });
}

async function companionRequest(threadId: string, suffix: string, init?: RequestInit): Promise<ToolResult> {
  const catId = process.env.CAT_CAFE_CAT_ID?.trim();
  if (!catId) return errorResult('The current cat identity is required for a realtime companion session.');
  const apiUrl = (process.env.CAT_CAFE_API_URL ?? 'http://127.0.0.1:3004').replace(/\/$/, '');
  const userId = process.env.CAT_CAFE_USER_ID ?? 'default-user';
  try {
    const response = await fetch(
      `${apiUrl}/api/threads/${encodeURIComponent(threadId.trim())}/realtime-companion${suffix}`,
      {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'x-cat-cafe-user': userId,
          'x-cat-id': catId,
        },
      },
    );
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok) {
      return errorResult(
        typeof data?.error === 'string'
          ? `${data.error}${typeof data.code === 'string' ? ` (${data.code})` : ''}`
          : `Realtime companion request failed: ${response.status}`,
      );
    }
    return successResult(JSON.stringify(data ?? { status: response.status }, null, 2));
  } catch (error) {
    return errorResult(
      `Cannot reach Clowder AI API at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const realtimeCompanionTools = [
  defineTool({
    name: 'cat_cafe_realtime_companion_start',
    description:
      'Start the narrow experimental Codex Realtime companion for the current cat and exact thread. Use when: running in Alpha after the user explicitly asks for watch-video commentary or meeting companionship and F195 audio capture is already active on that same thread. NOT for: non-Alpha deployments, starting a microphone, arbitrary realtime prompts, raw host control, or background always-on listening. Output: an active text-only companion session; transcript remains owned by F195 and replies use the existing Clowder AI message store.',
    inputSchema: realtimeCompanionStartInputSchema,
    handler: handleRealtimeCompanionStart,
    governance: {
      implementationExport: 'handleRealtimeCompanionStart',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: ADMISSION_REF,
      },
    },
  }),
  defineTool({
    name: 'cat_cafe_realtime_companion_status',
    description:
      'Read whether the current cat has an active experimental realtime companion on an exact Clowder AI thread. Use when: running in Alpha to check readiness after start, confirm shutdown, or diagnose a missing companion reply. NOT for: non-Alpha availability claims, reading transcript content, or starting/inspecting F195 audio capture. Output: read-only active/inactive state plus the bound consumer and native session coordinates when active.',
    inputSchema: realtimeCompanionStatusInputSchema,
    handler: handleRealtimeCompanionStatus,
    governance: {
      implementationExport: 'handleRealtimeCompanionStatus',
      action: 'command',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'progressive-disclosure',
        admissionRef: ADMISSION_REF,
      },
    },
  }),
  defineTool({
    name: 'cat_cafe_realtime_companion_stop',
    description:
      'Stop the current cat’s experimental realtime companion on an exact thread. Use when: running in Alpha after the user asks to end watch-video reactions or meeting companionship while keeping capture available. NOT for: non-Alpha deployments or stopping/taking ownership of F195 audio capture. Output: stopped/inactive state after the Codex realtime transport is detached; the underlying capture continues unchanged.',
    inputSchema: realtimeCompanionStopInputSchema,
    handler: handleRealtimeCompanionStop,
    governance: {
      implementationExport: 'handleRealtimeCompanionStop',
      action: 'command',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'side-effect-boundary',
        admissionRef: ADMISSION_REF,
      },
    },
  }),
] as const;
