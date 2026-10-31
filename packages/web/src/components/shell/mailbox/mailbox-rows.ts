import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useRef, useSyncExternalStore } from 'react';
import type { ApprovalSession, ApprovalSessions } from './approval-sessions';

export type MailboxDisplayRow =
  | { key: string; kind: 'item'; item: UnifiedAttentionItemV1 }
  | { key: string; kind: 'retained'; session: ApprovalSession }
  | { key: string; kind: 'feedback'; item: UnifiedAttentionItemV1; result: 'handled' | 'ignored' };
export function mailboxRowKey(item: UnifiedAttentionItemV1): string {
  return item.approval ? JSON.stringify([item.approval.sourceFeatureId, item.approval.proposalId]) : item.decisionRef;
}

/** One row per canonical decision. Conflicting duplicate payloads remain in the authoritative read for the write guard. */
export function projectMailboxRows(
  items: readonly UnifiedAttentionItemV1[],
  sessions: readonly ApprovalSession[],
  previous: readonly string[],
): MailboxDisplayRow[] {
  const seen = new Set<string>();
  const workCopies = new Map<string, number>();
  const rows: MailboxDisplayRow[] = items.flatMap((item) => {
    const base = mailboxRowKey(item);
    if (item.approval && seen.has(base)) return [];
    const nth = workCopies.get(base) ?? 0;
    const key = item.approval || nth === 0 ? base : `${base}#${nth}`;
    if (!item.approval) workCopies.set(base, nth + 1);
    seen.add(base);
    return [{ kind: 'item' as const, key, item }];
  });
  const retained = sessions
    .filter((session) => session.model.state.kind !== 'idle')
    .map((session) => ({
      key: JSON.stringify([session.address.sourceFeatureId, session.address.proposalId]),
      kind: 'retained' as const,
      session,
    }))
    .filter((row) => !seen.has(row.key));
  retained.sort((a, b) => previous.indexOf(a.key) - previous.indexOf(b.key));
  for (const row of retained) {
    const index = previous.indexOf(row.key);
    rows.splice(index < 0 ? rows.length : Math.min(index, rows.length), 0, row);
  }
  return rows;
}

export function useMailboxRows(
  items: readonly UnifiedAttentionItemV1[],
  sessions: ApprovalSessions,
  ownerUserId: string | null,
): MailboxDisplayRow[] {
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const previous = useRef<{ owner: string | null; keys: string[] }>({ owner: null, keys: [] });
  if (ownerUserId === null) return [];
  const rows = projectMailboxRows(
    items,
    sessions.list().filter((session) => session.ownerUserId === ownerUserId),
    previous.current.owner === ownerUserId ? previous.current.keys : [],
  );
  previous.current = { owner: ownerUserId, keys: rows.map((row) => row.key) };
  return rows;
}
