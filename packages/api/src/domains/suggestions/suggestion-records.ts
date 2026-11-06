import {
  DEFAULT_SUGGESTION_EXPIRY_MINUTES,
  type SuggestionDeskWork,
  type SuggestionOpenTarget,
} from '@cat-cafe/shared';
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

export const BROUGHT_WORK_KIND = 'brought-work';
export const BROUGHT_WORK_LABEL = '带来的作品';
/** A brought work waits for the person to come back; it is not a pill that goes stale in a day. */
const BROUGHT_WORK_EXPIRY_MS = 7 * 24 * 60 * 60_000;

/** F335 交付三：a work a cat made first, brought to the desk; anchored on the message that carries its card. */
export function broughtWorkRecord(input: {
  id: string;
  now: number;
  actor: RecordActor;
  messageId: string;
  sentence: string;
  work: SuggestionDeskWork;
}): SuggestionRecord {
  const { now, actor } = input;
  return {
    id: input.id,
    userId: actor.userId,
    threadId: actor.threadId,
    messageId: input.messageId,
    catId: actor.catId,
    byline: actor.byline ?? 'cat',
    kind: BROUGHT_WORK_KIND,
    kindLabel: BROUGHT_WORK_LABEL,
    label: input.sentence,
    params: {},
    state: 'open',
    undo: null,
    receiptOnly: false,
    desk: { sentence: input.sentence, work: input.work, status: 'pending' },
    events: [{ type: 'offered', at: now }],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + BROUGHT_WORK_EXPIRY_MS,
  };
}
