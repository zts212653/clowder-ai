import type { UnifiedAttentionItemGroupCountsV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { ShellGlyph } from '../ShellIcons';
import { useShellCopy } from '../shell-copy';
import { isMailboxDecision } from './mailbox-decision-kind';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { MailboxDisplayRow } from './mailbox-rows';

/** Group the canonical rows without losing retained decisions, repairs or original actions. */
export function MailboxItemGroups({
  section,
  rows,
  complete,
  readKnown,
  renderRow,
  mentionControls,
  groupCounts,
}: {
  section: 'pending' | 'ignored';
  mentionControls?: ReactNode;
  groupCounts?: UnifiedAttentionItemGroupCountsV1;
  rows: MailboxDisplayRow[];
  complete: boolean;
  readKnown: boolean;
  renderRow: (row: MailboxDisplayRow) => ReactNode;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  if (
    section === 'ignored' &&
    rows.length === 0 &&
    (!groupCounts || !Object.values(groupCounts).some((count) => count > 0))
  ) {
    return (
      <p data-testid="mailbox-ignored-empty" className="m-0 py-2 text-sm" style={{ color: 'var(--shell-muted)' }}>
        {!readKnown ? t.state.unconfirmed : complete ? t.ignoredEmpty : t.ignoredPageEmpty}
      </p>
    );
  }
  const waiting = (row: MailboxDisplayRow) =>
    row.kind === 'retained' ||
    ((row.kind === 'item' || row.kind === 'feedback') &&
      row.item.kind !== 'user_mention' &&
      isMailboxDecision(row.item));
  const groups = [
    {
      id: 'decisions',
      count: groupCounts?.decisions,
      label: t.decisions,
      empty: !readKnown
        ? t.state.unconfirmed
        : groupCounts?.decisions === 0 || (complete && !groupCounts)
          ? t.decisionsEmpty
          : t.decisionsPageEmpty,
      rows: rows.filter(waiting),
    },
    {
      id: 'mentions',
      count: groupCounts?.userMentions,
      label: t.mentions,
      empty: !readKnown
        ? t.state.unconfirmed
        : groupCounts?.userMentions === 0 || (complete && !groupCounts)
          ? t.mentionsEmpty
          : t.mentionsPageEmpty,
      rows: rows.filter((row) => (row.kind === 'item' || row.kind === 'feedback') && row.item.kind === 'user_mention'),
    },
  ];
  const other = rows.filter(
    (row) => (row.kind === 'item' || row.kind === 'feedback') && row.item.kind !== 'user_mention' && !waiting(row),
  );
  if (other.length || (groupCounts?.other ?? 0) > 0)
    groups.push({ id: 'other', count: groupCounts?.other, label: t.other, empty: t.otherPageEmpty, rows: other });
  return (
    <div className="flex flex-col gap-5">
      {(section === 'ignored' ? groups.filter((group) => group.rows.length > 0 || (group.count ?? 0) > 0) : groups).map(
        (group) => (
          <section key={group.id} data-testid={`mailbox-group-${group.id}`} aria-label={group.label}>
            {group.id === 'mentions' && mentionControls ? (
              mentionControls
            ) : (
              <h3 className="mb-2 mt-0 flex items-center gap-1.5 text-sm font-semibold">
                {group.id === 'decisions' ? <ShellGlyph name="checkSquare" className="h-4 w-4" /> : null}
                {group.label}
                <span className="font-normal" style={{ color: 'var(--shell-muted)' }}>
                  {group.count !== undefined
                    ? group.count
                    : !readKnown
                      ? t.state.unconfirmed
                      : t.pageItems(group.rows.length)}
                </span>
              </h3>
            )}
            {group.rows.length ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">{group.rows.map(renderRow)}</ul>
            ) : (
              <p className="m-0 py-2 text-sm" style={{ color: 'var(--shell-muted)' }}>
                {group.empty}
              </p>
            )}
          </section>
        ),
      )}
    </div>
  );
}
