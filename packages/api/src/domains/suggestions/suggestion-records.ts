import { DEFAULT_SUGGESTION_EXPIRY_MINUTES, type SuggestionOpenTarget } from '@cat-cafe/shared';
import type { SuggestionRecord } from './SuggestionStore.js';
import type { SuggestionActionHandler } from './suggestion-actions.js';
import { PLAIN_RECEIPT_KIND, PLAIN_RECEIPT_LABEL } from './suggestion-projection.js';

interface RecordActor {
  userId: string;
  threadId: string;
  catId: string;
  byline?: SuggestionRecord['byline'];
}

/** A fresh pill: open until the person taps, dismisses, or it expires as 「不理」. */
export function offerRecord(input: {
  id: string;
  now: number;
  actor: RecordActor;
  messageId: string;
  handler: SuggestionActionHandler;
  label: string;
  params: Record<string, unknown>;
  expiresInMinutes?: number;
}): SuggestionRecord {
  const { now, actor, handler } = input;
  return {
    id: input.id,
    userId: actor.userId,
    threadId: actor.threadId,
    messageId: input.messageId,
    catId: actor.catId,
    byline: actor.byline ?? 'cat',
    kind: handler.kind,
    kindLabel: handler.kindLabel,
    label: input.label,
    params: input.params,
    state: 'open',
    undo: handler.undoLabel,
    receiptOnly: false,
    events: [{ type: 'offered', at: now }],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (input.expiresInMinutes ?? DEFAULT_SUGGESTION_EXPIRY_MINUTES) * 60_000,
  };
}

/** A line for something already done; undoable only through a registered action. */
export function receiptRecord(input: {
  id: string;
  now: number;
  actor: RecordActor;
  messageId: string;
  text: string;
  handler: SuggestionActionHandler | undefined;
  appliedRef: Record<string, unknown> | undefined;
  open?: SuggestionOpenTarget;
}): SuggestionRecord {
  const { now, actor, handler, text } = input;
  return {
    id: input.id,
    userId: actor.userId,
    threadId: actor.threadId,
    messageId: input.messageId,
    catId: actor.catId,
    byline: actor.byline ?? 'cat',
    kind: handler?.kind ?? PLAIN_RECEIPT_KIND,
    kindLabel: handler?.kindLabel ?? PLAIN_RECEIPT_LABEL,
    label: text,
    params: {},
    state: 'applied',
    ...(input.appliedRef ? { appliedRef: input.appliedRef } : {}),
    receipt: input.open ? { text, open: input.open } : { text },
    undo: handler ? handler.undoLabel : null,
    receiptOnly: true,
    events: [{ type: 'receipted', at: now }],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
  };
}
