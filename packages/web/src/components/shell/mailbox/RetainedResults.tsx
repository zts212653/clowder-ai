import { useSyncExternalStore } from 'react';
import { useApprovalHeading } from './approval-heading';
import { describeReconcile } from './approval-reconcile';
import { type ApprovalSession, type ApprovalSessions, sessionKey } from './approval-sessions';

const MUTED = { color: 'var(--shell-muted)' } as const;

/** A decision still being written or confirmed is not the user's to dismiss; every other state is theirs to read and clear. */
const IN_FLIGHT = new Set(['writing', 'confirming']);

/** The session behind an approval row, for this owner; undefined when the row has never been acted on. */
export function sessionOfRow(
  sessions: ApprovalSessions,
  ownerUserId: string,
  approval: { sourceFeatureId: string; proposalId: string },
): ApprovalSession | undefined {
  return sessions.get(sessionKey(ownerUserId, approval));
}

function RetainedResult({ session, sessions }: { session: ApprovalSession; sessions: ApprovalSessions }) {
  const { lead, title } = useApprovalHeading(session.approval);
  const view = describeReconcile(session.model.state);
  return (
    <li
      data-testid="mailbox-retained-result"
      data-state={session.model.state.kind}
      className="flex flex-col gap-1.5 rounded-[14px] px-4 py-3 text-sm"
      style={{ border: '1px solid var(--shell-hairline)', background: 'var(--shell-paper)' }}
    >
      <span className="block">
        <span className="font-semibold">{lead} </span>
        {title}
      </span>
      {view.line ? (
        <output className="m-0 block font-medium" data-testid="mailbox-retained-line">
          {view.line}
        </output>
      ) : null}
      <div className="flex items-center gap-2">
        {view.canReread ? (
          <button
            type="button"
            data-testid="mailbox-retained-reread"
            onClick={() => sessions.reread(session.key)}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
          >
            重新读取
          </button>
        ) : null}
        {IN_FLIGHT.has(session.model.state.kind) ? null : (
          <button
            type="button"
            data-testid="mailbox-retained-dismiss"
            onClick={() => sessions.close(session.key)}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
            style={MUTED}
          >
            知道了
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * F322 S3-2b-1c: results that outlive the row they belong to.
 *
 * The moment a decision is made the read stops listing it, so the row goes. What the panel proved about it (已批准, or that
 * it could not be confirmed and why) stays as its own row until the user dismisses it, so a result is never lost to the
 * very read that confirmed it. Only for the owner who made it, only while that owner is confirmed by the read now shown, and
 * never counted: the number on the rail is what the read proved, not a tally kept here.
 */
export function RetainedResults({
  sessions,
  ownerUserId,
  listedKeys,
}: {
  sessions: ApprovalSessions;
  /** The owner of the read now shown, or null when no read confirms one. */
  ownerUserId: string | null;
  /** The sessions whose approval the read still lists: their row says it, so they are not repeated. */
  listedKeys: ReadonlySet<string>;
}) {
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  if (ownerUserId === null) return null;
  const retained = sessions
    .list()
    .filter(
      (session) =>
        session.ownerUserId === ownerUserId && !listedKeys.has(session.key) && session.model.state.kind !== 'idle',
    );
  if (retained.length === 0) return null;
  return (
    <ul className="m-0 mb-2 flex list-none flex-col gap-2 p-0" data-testid="mailbox-retained">
      {retained.map((session) => (
        <RetainedResult key={session.key} session={session} sessions={sessions} />
      ))}
    </ul>
  );
}
