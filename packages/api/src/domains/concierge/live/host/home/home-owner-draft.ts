import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';

/** The composer owner remains the only durable writer; this adapter adds a literal span using its CAS. */
export async function appendHomeOwnerDraft(input: {
  messages: Pick<IMessageStore, 'getOwnerComposerDraft' | 'putOwnerComposerDraft'>;
  threads: Pick<IThreadStore, 'list'>;
  ownerUserId: string;
  threadId: string;
  expectedRevision: number;
  literal: string;
  isCurrent(): Promise<boolean>;
  signal: AbortSignal;
}) {
  if (input.signal.aborted || !input.literal || input.literal.length > 2_000) return { kind: 'blocked' } as const;
  const visible = await input.threads.list(input.ownerUserId);
  if (!visible.some((t) => t.id === input.threadId && !t.deletedAt)) return { kind: 'blocked' } as const;
  const draft = await input.messages.getOwnerComposerDraft(input.ownerUserId, input.threadId);
  if ((draft?.revision ?? 0) !== input.expectedRevision) return { kind: 'conflict' } as const;
  const text = (draft?.text ?? '') + (draft?.text && !draft.text.endsWith('\n') ? '\n' : '') + input.literal;
  if (text.length > 32_000) return { kind: 'blocked' } as const;
  if (!(await input.isCurrent()) || input.signal.aborted) return { kind: 'stale' } as const;
  const result = await input.messages.putOwnerComposerDraft(input.ownerUserId, input.threadId, {
    expectedRevision: input.expectedRevision,
    text,
    ...(draft?.contentBlocks ? { contentBlocks: draft.contentBlocks } : {}),
    ...(draft?.replyTo ? { replyTo: draft.replyTo } : {}),
    updatedAt: Date.now(),
  });
  return result.kind === 'updated' ? result : ({ kind: 'conflict' } as const);
}
