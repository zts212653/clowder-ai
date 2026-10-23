import { MarkdownContent } from '@/components/MarkdownContent';
import { memoryCorrectionCopy } from '@/components/memory/page/memory-correction.shell-copy';
import { isDomainApprovalFeature } from '@/components/rich/DomainApprovalCard';
import { domainApprovalCopy } from '@/components/rich/domain-approval.shell-copy';
import { evalRepairCopy } from '@/components/rich/eval-repair.shell-copy';
import { scheduleApprovalCopy } from '@/components/rich/schedule-approval.shell-copy';
import { PersonMemoryRetainedReceipt } from '../../rich/PersonMemoryRetainedReceipt';
import { personMemoryCopy } from '../../rich/person-memory.shell-copy';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { ApprovalDecisionReceipt } from './ApprovalDecisionReceipt';
import { ApprovalResultLink } from './ApprovalResultLink';
import { useApprovalHeading } from './approval-heading';
import { describeReconcile } from './approval-reconcile';
import { approvalReconcileCopy } from './approval-reconcile.shell-copy';
import { type ApprovalSession, type ApprovalSessions } from './approval-sessions';
import { originalApprovalCopy } from './original-approval.shell-copy';
import { useOriginalApprovalEffect } from './use-original-approval-effect';

const MUTED = { color: 'var(--shell-muted)' } as const;

/** A decision still being written or confirmed is not the user's to dismiss; every other state is theirs to read and clear. */
const IN_FLIGHT = new Set(['writing', 'confirming']);

export function RetainedResult({ session, sessions }: { session: ApprovalSession; sessions: ApprovalSessions }) {
  const { lead, title: heading } = useApprovalHeading(session.approval);
  const originalCopy = useShellCopy(originalApprovalCopy);
  const domainCopy = useShellCopy(domainApprovalCopy);
  const correctionCopy = useShellCopy(memoryCorrectionCopy);
  const scheduleCopy = useShellCopy(scheduleApprovalCopy);
  const repairCopy = useShellCopy(evalRepairCopy);
  const personCopy = useShellCopy(personMemoryCopy);
  const feature = session.approval.sourceFeatureId;
  const fact =
    feature === 'F193'
      ? session.approval.detail.content
      : feature === 'F221'
        ? (session.approval.detail.takeaway ?? session.approval.detail.quote)
        : session.approval.detail.canonicalName;
  const title =
    feature === 'F276'
      ? personCopy.kind
      : feature === 'F266'
        ? `${repairCopy.kind}: ${session.approval.summary.replace(/^Eval repair\s*·\s*/u, '')}`
        : feature === 'F225' || feature === 'F231'
          ? originalCopy.kind[feature]
          : isDomainApprovalFeature(feature)
            ? `${domainCopy.kind[feature]}: ${typeof fact === 'string' ? fact.split('\n')[0] : domainCopy.unknown}`
            : feature === 'F139'
              ? `${scheduleCopy.kind}: ${session.approval.summary.replace(/^(Create|Delete) schedule: /, '')}`
              : feature === 'F321'
                ? correctionCopy.kind
                : heading;
  const language = useShellLanguage();
  const t = useShellCopy(approvalReconcileCopy);
  const originalEffect = useOriginalApprovalEffect(session);
  const state = session.model.state;
  const displayed =
    (feature === 'F139' || feature === 'F266') &&
    state.kind === 'decided' &&
    state.terminal.resolution === 'accepted' &&
    !originalEffect
      ? { ...state, terminal: { ...state.terminal, effectUnknown: true } }
      : state;
  const view = describeReconcile(displayed, {
    language,
    ownerUserId: session.ownerUserId,
    sourceFeatureId: feature,
    originalEffect,
  });
  if (state.kind === 'decided') {
    return (
      <li
        data-testid="mailbox-retained-result"
        data-decision-key={JSON.stringify([session.address.sourceFeatureId, session.address.proposalId])}
        data-state={state.kind}
        className="min-w-0 px-4 py-2 text-sm"
      >
        <div data-testid="mailbox-retained-line">
          <ApprovalDecisionReceipt
            session={session}
            terminal={displayed.kind === 'decided' ? displayed.terminal : state.terminal}
            line={[view.line, feature === 'F128' ? null : title].filter(Boolean).join(' · ')}
            heading={title}
          >
            {view.canReread ? (
              <button
                type="button"
                data-testid="mailbox-retained-reread"
                onClick={() => sessions.reread(session.key)}
                className="shell-focusable text-xs"
              >
                {t.reread}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="mailbox-retained-dismiss"
              onClick={() => sessions.close(session.key)}
              className="shell-focusable text-xs"
              style={MUTED}
            >
              {t.dismiss}
            </button>
          </ApprovalDecisionReceipt>
        </div>
      </li>
    );
  }
  return (
    <li
      data-testid="mailbox-retained-result"
      data-decision-key={JSON.stringify([session.address.sourceFeatureId, session.address.proposalId])}
      data-state={session.model.state.kind}
      className="flex flex-col gap-1.5 rounded-[14px] px-4 py-3 text-sm"
      style={{ border: '1px solid var(--shell-hairline)', background: 'var(--shell-paper)' }}
    >
      <div className="block">
        <span className="font-semibold">{lead} </span>
        <MarkdownContent content={title} className="!text-sm [&_p]:mb-0" disableCommandPrefix />
        {feature === 'F276' &&
        typeof session.approval.detail.displayName === 'string' &&
        session.approval.detail.displayName.trim() ? (
          <p data-testid="person-memory-result-subject">{personCopy.person(session.approval.detail.displayName)}</p>
        ) : null}
      </div>
      {feature !== 'F276' && view.line ? (
        <output className="m-0 block font-medium" data-testid="mailbox-retained-line">
          {view.line}
        </output>
      ) : null}
      {feature === 'F276' ? (
        <PersonMemoryRetainedReceipt approval={session.approval} ownerUserId={session.ownerUserId} />
      ) : null}
      <div className="flex items-center gap-2">
        <ApprovalResultLink state={session.model.state} />
        {view.canReread ? (
          <button
            type="button"
            data-testid="mailbox-retained-reread"
            onClick={() => sessions.reread(session.key)}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
          >
            {t.reread}
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
            {t.dismiss}
          </button>
        )}
      </div>
    </li>
  );
}
