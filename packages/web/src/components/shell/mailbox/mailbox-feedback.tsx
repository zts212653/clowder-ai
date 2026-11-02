import {
  ignoredItemKey,
  type UnifiedAttentionItemV1,
  type UnifiedAttentionPreferenceCoordinate,
} from '@cat-cafe/shared';
import { createContext, useContext, useRef, useState } from 'react';
import type { MailboxDisplayRow } from './mailbox-rows';

type Feedback = { item: UnifiedAttentionItemV1; index: number; result: 'handled' | 'ignored'; owner: string };
type Acknowledgement = { owner: string } & (
  | { result: 'handled'; threadId: string; messageId: string; expectedRevision: number }
  | { result: 'ignored'; coordinates: UnifiedAttentionPreferenceCoordinate[] }
);
export const MailboxFeedback = createContext<(ack: Acknowledgement) => void>(() => {});
export const useMailboxFeedback = () => useContext(MailboxFeedback);

/** Disposable UI feedback from successful exact writes, never inferred from a disappearing source row. */
export function usePendingFeedback(items: readonly UnifiedAttentionItemV1[], owner: string | null) {
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const seen = useRef<{ owner: string | null; items: UnifiedAttentionItemV1[] }>({ owner: null, items: [] });
  if (seen.current.owner !== owner) seen.current = { owner, items: [] };
  // Keep the actual rows the person could have acted on during this open panel, across a write's refresh.
  for (const item of items) {
    const index = seen.current.items.findIndex((previous) => sameItem(previous, item));
    if (index < 0) seen.current.items.push(item);
    else seen.current.items[index] = item;
  }
  const acknowledge = (ack: Acknowledgement) => {
    if (!owner || ack.owner !== owner || seen.current.owner !== owner) return;
    const keys = ack.result === 'ignored' ? new Set(ack.coordinates.map(ignoredItemKey)) : null;
    const matched = seen.current.items.filter((item) =>
      ack.result === 'handled'
        ? item.userMention?.threadId === ack.threadId &&
          item.userMention.messageId === ack.messageId &&
          item.userMention.expectedRevision === ack.expectedRevision
        : !!item.preferenceCoordinate && keys?.has(ignoredItemKey(item.preferenceCoordinate)),
    );
    setFeedback((previous) => {
      const next = previous.filter((entry) => entry.owner === owner);
      for (const item of matched)
        if (!next.some((entry) => sameItem(entry.item, item)))
          next.push({ item, owner, result: ack.result, index: seen.current.items.indexOf(item) });
      return next;
    });
  };
  const project = (rows: MailboxDisplayRow[]): MailboxDisplayRow[] => {
    const current = feedback.filter((entry) => entry.owner === owner);
    const result = rows.filter(
      (row) => row.kind !== 'item' || !current.some((entry) => sameItem(entry.item, row.item)),
    );
    for (const entry of current)
      result.splice(Math.min(entry.index, result.length), 0, {
        kind: 'feedback',
        key: `feedback:${entry.item.decisionRef}:${entry.item.userMention?.messageId ?? JSON.stringify(entry.item.preferenceCoordinate)}`,
        item: entry.item,
        result: entry.result,
      });
    return result;
  };
  return { acknowledge, project };
}

function sameItem(a: UnifiedAttentionItemV1, b: UnifiedAttentionItemV1) {
  if (a.userMention || b.userMention)
    return (
      a.userMention?.messageId === b.userMention?.messageId &&
      a.userMention?.expectedRevision === b.userMention?.expectedRevision
    );
  return (
    !!a.preferenceCoordinate &&
    !!b.preferenceCoordinate &&
    ignoredItemKey(a.preferenceCoordinate) === ignoredItemKey(b.preferenceCoordinate)
  );
}
