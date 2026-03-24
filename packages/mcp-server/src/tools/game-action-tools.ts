import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const userId = process.env['CAT_CAFE_USER_ID'];
  if (userId) headers['x-cat-cafe-user'] = userId;
  const catId = process.env['CAT_CAFE_CAT_ID'];
  if (catId) headers['x-cat-id'] = catId;
  headers['content-type'] = 'application/json';
  return headers;
}

export const submitGameActionInputSchema = {
  gameId: z.string().min(1).describe('Game UUID'),
  round: z.number().int().min(1).describe('Current round number'),
  phase: z.string().min(1).describe('Current phase name (e.g. night_wolf, day_vote)'),
  seat: z.number().int().min(1).describe('Your seat number'),
  action: z.string().min(1).describe('Action type: kill/guard/divine/vote/speak/last_words'),
  target: z.number().int().min(1).optional().describe('Target seat number (for kill/guard/divine/vote)'),
  text: z.string().max(2000).optional().describe('Speech content (for speak/last_words)'),
  nonce: z.string().min(1).max(200).describe('Unique string for idempotency'),
};

export async function handleSubmitGameAction(input: {
  gameId: string;
  round: number;
  phase: string;
  seat: number;
  action: string;
  target?: number;
  text?: string;
  nonce: string;
}): Promise<ToolResult> {
  const url = `${API_URL}/api/game/${input.gameId}/action`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({
        round: input.round,
        phase: input.phase,
        seat: input.seat,
        action: input.action,
        target: input.target,
        text: input.text,
        nonce: input.nonce,
      }),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      return errorResult(`Action rejected (${res.status}): ${data.error ?? JSON.stringify(data)}`);
    }

    if (data.deduplicated) {
      return successResult('Action already submitted (deduplicated). No effect.');
    }

    return successResult('Action accepted.');
  } catch (err) {
    return errorResult(`Submit action failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const gameActionTools = [
  {
    name: 'cat_cafe_submit_game_action',
    description:
      'Submit a game action (kill/guard/divine/vote/speak/last_words). ' +
      'Only use when you are woken up for a game phase that requires your action. ' +
      'Server validates round/phase/seat/role automatically — invalid actions are rejected. ' +
      'GOTCHA: Always include a unique nonce string for idempotency — duplicate nonces are silently deduplicated. ' +
      'GOTCHA: target is required for kill/guard/divine/vote; text is required for speak/last_words.',
    inputSchema: submitGameActionInputSchema,
    handler: handleSubmitGameAction,
  },
] as const;
