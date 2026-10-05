import { type CompanionReply as ModernReply, validateCompanionReply } from '@clowder-ai/plugin-contract-beta23';
import { z } from 'zod';
import { CompanionBridgeError, type CompanionOwnerClient } from '../companion-owner-client.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CompanionBridgeError('unavailable');
  return value as Record<string, unknown>;
};

/** Stable receipts describe backend acceptance, never voice append or playback. */
export async function sendCompanionText(options: {
  client: CompanionOwnerClient;
  text: string;
  clientMessageId: string;
  callId?: string;
  modern: boolean;
  conversationThread(): Promise<string>;
}): Promise<ModernReply | { kind: 'delivery'; delivery: 'accepted' | 'unconfirmed' }> {
  const { client, callId, clientMessageId } = options;
  const unconfirmed = () =>
    options.modern
      ? ({
          kind: 'delivery',
          delivery: 'unconfirmed',
          clientMessageId,
          messageId: null,
          callId: callId ?? null,
        } as const)
      : ({ kind: 'delivery', delivery: 'unconfirmed' } as const);
  let result: Record<string, unknown>;
  try {
    result = callId
      ? await client.request(`/api/concierge/live/${encodeURIComponent(callId)}/text`, 'POST', {
          text: options.text,
          clientMessageId,
        })
      : await client.request('/api/messages', 'POST', {
          content: options.text,
          threadId: await options.conversationThread(),
          idempotencyKey: clientMessageId,
        });
  } catch (error) {
    if (error instanceof CompanionBridgeError && error.code === 'unavailable') return unconfirmed();
    throw error;
  }
  const accepted = callId
    ? result.delivery === 'accepted'
    : ['processing', 'queued', 'duplicate'].includes(String(result.status));
  if (!options.modern) return { kind: 'delivery', delivery: accepted ? 'accepted' : 'unconfirmed' };
  const id = z
    .string()
    .trim()
    .min(1)
    .max(256)
    .safeParse(callId ? result.messageId : result.userMessageId);
  return accepted && id.success
    ? { kind: 'delivery', delivery: 'accepted', clientMessageId, messageId: id.data, callId: callId ?? null }
    : unconfirmed();
}

/** Scope and sources come from the owner/call projection; no renderer selectors. */
export async function readModernCompanionTranscript(
  client: CompanionOwnerClient,
  callId: string,
): Promise<ModernReply> {
  const result = await client.request(`/api/concierge/live/${encodeURIComponent(callId)}/transcript`);
  const scope = object(result.scope);
  if (scope.callId !== callId || !Array.isArray(result.messages)) throw new CompanionBridgeError('unavailable');
  const rows = result.messages.map((value: unknown) => {
    const row = object(value);
    const source = object(row.source);
    if (source.callId !== callId) throw new CompanionBridgeError('unavailable');
    if (source.kind === 'voice' && source.realtimeSessionId !== scope.realtimeSessionId)
      throw new CompanionBridgeError('unavailable');
    const { callId: _privateVoiceCall, ...voice } = source;
    return { messageId: row.id, role: row.role, text: row.text, source: source.kind === 'voice' ? voice : source };
  });
  const reply = { kind: 'transcript', scope, rows, hasMore: result.hasMore };
  if (!validateCompanionReply(reply)) throw new CompanionBridgeError('unavailable');
  return reply;
}
