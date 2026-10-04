import { catRegistry, companionIdentitySnapshotV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { HostCompanionReply as CompanionReply } from '../../../plugin/desktop-window-runtime/companion-private-wire.js';
import { CompanionBridgeError, type CompanionOwnerClient } from '../companion-owner-client.js';
import { clipLiveText } from '../live-text-budget.js';

const savedCompanionIdentity = z.object({
  liveCompanion: z.object({ identity: companionIdentitySnapshotV1Schema }),
});

/** The same canonical conversation and bounded history for both public ABIs. */
export async function readCompanionConversation(options: {
  client: CompanionOwnerClient;
  includeSavedIdentity: boolean;
  conversationThread(): Promise<string>;
}): Promise<CompanionReply> {
  const threadId = await options.conversationThread();
  const thread = await options.client.request(`/api/threads/${encodeURIComponent(threadId)}`);
  const threadTitle = z.string().trim().min(1).max(256).parse(thread.title);
  const result = await options.client.request(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=32`);
  const row = z.object({
    id: z.string().max(256),
    type: z.enum(['user', 'assistant']),
    content: z.string(),
    catId: z.string().nullable(),
    extra: z.unknown().optional(),
  });
  const messages: Array<Extract<CompanionReply, { kind: 'conversation' }>['messages'][number]> = [];
  let remaining = 24000;
  let hasMore = result.hasMore === true;
  if (!Array.isArray(result.messages)) throw new CompanionBridgeError('unavailable');
  for (const candidate of result.messages.slice(-32).reverse()) {
    const parsed = row.safeParse(candidate);
    if (!parsed.success || !parsed.data.content.trim()) continue;
    const message = parsed.data;
    if (remaining <= 0) {
      hasMore = true;
      break;
    }
    const text = clipLiveText(message.content, Math.min(16000, remaining));
    if (!text) {
      hasMore = true;
      continue;
    }
    remaining -= text.length;
    if (text.length !== message.content.length) hasMore = true;
    const saved =
      options.includeSavedIdentity && message.type === 'assistant'
        ? savedCompanionIdentity.safeParse(message.extra)
        : null;
    const companionIdentity =
      saved?.success && message.catId === saved.data.liveCompanion.identity.live.catId
        ? saved.data.liveCompanion.identity
        : undefined;
    messages.unshift({
      id: message.id,
      role: message.type,
      text,
      name: message.catId
        ? (catRegistry.tryGet(message.catId)?.config.displayName ?? message.catId).slice(0, 256)
        : '你',
      ...(companionIdentity ? { companionIdentity } : {}),
    });
  }
  return { kind: 'conversation', threadTitle, messages, hasMore };
}
