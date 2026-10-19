import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '../shell-copy';
import { type MailboxState, mailboxStateText, sourceStatusText } from '../unified-mailbox-state';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';

export function MailboxReadNotes({
  state,
  read,
  stale,
}: {
  state: MailboxState;
  read: UnifiedAttentionReadV1 | null;
  stale: boolean;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const stateText =
    state.kind === 'has-items' && !state.partial && state.count !== null
      ? t.scopeTotal(state.count)
      : mailboxStateText(state, t);
  const sources = read
    ? [
        { id: 'approvals', label: t.source.approvals, source: read.sources.approvals },
        { id: 'needs-me', label: t.source.needsMe, source: read.sources.needsMe },
        {
          id: 'collective-accountability',
          label: t.source.accountability,
          source: read.sources.collectiveAccountabilityRequests,
        },
        { id: 'user-mentions', label: t.mentions, source: read.sources.userMentions },
        { id: 'choices', label: t.source.choices, source: read.sources.structuredChoices },
        { id: 'preferences', label: t.source.personal, source: read.sources.personalPreferences },
      ].flatMap((entry) => {
        const text = entry.source ? sourceStatusText(entry.source, t) : null;
        return text ? [{ ...entry, text }] : [];
      })
    : [];
  const partial =
    read && state.kind === 'partial' && Object.values(read.sources).every((source) => source.status === 'available')
      ? read.consistency.state === 'uncertain'
        ? t.consistencyUnknown
        : Object.values(read.sources).some((source) => source.exhaustiveness !== 'complete')
          ? t.coverageUnknown
          : null
      : null;
  return (
    <>
      {state.kind !== 'empty' ? (
        <p className="m-0 pb-1.5 text-xs" style={{ color: 'var(--shell-muted)' }} data-testid="mailbox-state-text">
          {stateText}
        </p>
      ) : null}
      {sources.length ? (
        <ul className="m-0 mb-1 list-none p-0 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {sources.map((note) => (
            <li key={note.id} data-testid={`mailbox-source-note-${note.id}`}>
              {note.label}：{note.text}
            </li>
          ))}
        </ul>
      ) : null}
      {partial ? (
        <p className="m-0 pb-1 text-xs" style={{ color: 'var(--shell-muted)' }} data-testid="mailbox-partial-note">
          {partial}
        </p>
      ) : null}
      {stale ? (
        <p className="m-0 pb-1 text-xs" style={{ color: 'var(--shell-muted)' }} data-testid="mailbox-stale-note">
          {t.stale}
        </p>
      ) : null}
    </>
  );
}
