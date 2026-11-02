import type { ThreadProposal } from '@cat-cafe/shared';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { ApprovalMember } from './ApprovalMember';
import { proposalCardCopy } from './proposal-card.shell-copy';

export type ProposalDetails = Pick<
  ThreadProposal,
  | 'reason'
  | 'parentThreadId'
  | 'projectPath'
  | 'preferredCats'
  | 'initialMessage'
  | 'subjectTaskTitle'
  | 'subjectTaskId'
  | 'approvedDevelopmentScope'
>;

/** The original proposal's human-readable fields, shared by pending cards and expanded receipts. */
export function ProposalCardDetails({
  proposal,
  workMode,
  reportingMode,
}: {
  proposal: ProposalDetails;
  workMode?: ThreadProposal['declaredWorkMode'];
  reportingMode: NonNullable<ThreadProposal['reportingMode']>;
}) {
  const t = useShellCopy(proposalCardCopy);
  const { currentThread } = useThreadDisplayInfo(proposal.parentThreadId);
  const project =
    proposal.projectPath === 'default' ? t.unclassified : proposal.projectPath.split('/').filter(Boolean).at(-1);
  return (
    <>
      {' '}
      <details className="group text-sm" data-testid="proposal-reason">
        <summary className="shell-focusable cursor-pointer" style={{ color: 'var(--shell-body)' }}>
          <span className="hidden group-open:inline">{t.why}</span>
          <div className="line-clamp-3 break-words group-open:hidden">
            <MarkdownContent content={proposal.reason} className="!text-sm [&_p]:mb-0" disableCommandPrefix />
          </div>
        </summary>
        <div
          role="region"
          aria-label={t.why}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the expanded reason region supports keyboard scrolling
          tabIndex={0}
          className="mt-2 max-h-48 overflow-y-auto break-words"
        >
          <MarkdownContent content={proposal.reason} className="!text-sm" disableCommandPrefix />
        </div>
      </details>
      <dl className="m-0 space-y-1 text-xs">
        <div>
          <dt className="inline text-[var(--shell-muted)]">{t.executor}: </dt>
          <dd className="inline-flex flex-wrap items-center gap-2">
            {proposal.preferredCats.length
              ? proposal.preferredCats.map((catId) => <ApprovalMember key={catId} catId={catId} />)
              : t.unspecified}
          </dd>
        </div>
        <div>
          <dt className="inline text-[var(--shell-muted)]">{t.parent}: </dt>
          <dd className="inline break-words">{currentThread?.title || t.parentUnavailable}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--shell-muted)]">{t.project}: </dt>
          <dd className="inline break-words" title={proposal.projectPath}>
            {project}
          </dd>
        </div>
        <div>
          <dt className="inline text-[var(--shell-muted)]">{t.follow}: </dt>
          <dd className="inline">
            {workMode ? t.workMode[workMode] : t.unknown} · {t.reportingMode[reportingMode]}
          </dd>
        </div>
      </dl>
      {proposal.initialMessage ? (
        <details
          data-testid="proposal-initial-message"
          className="rounded-lg border border-[var(--shell-hairline)] p-2"
        >
          <summary className="shell-focusable cursor-pointer text-xs font-medium">{t.initial}</summary>
          <div
            role="region"
            className="mt-2 max-h-64 overflow-y-auto break-words"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded text region must support keyboard scrolling
            tabIndex={0}
            aria-label={t.initial}
          >
            <MarkdownContent content={proposal.initialMessage} className="!text-sm" disableCommandPrefix />
          </div>
        </details>
      ) : null}
      {proposal.approvedDevelopmentScope || proposal.subjectTaskId ? (
        <details className="text-xs">
          <summary className="shell-focusable cursor-pointer text-[var(--shell-muted)]">{t.technical}</summary>
          {proposal.subjectTaskTitle ? <p>{proposal.subjectTaskTitle}</p> : null}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(
              { subjectTaskId: proposal.subjectTaskId, scope: proposal.approvedDevelopmentScope },
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
    </>
  );
}
