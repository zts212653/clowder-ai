import type { ThreadProposal } from '@cat-cafe/shared';
import { stripProposalLeadingMentions } from '@cat-cafe/shared/proposal-message';
import { useEffect, useRef } from 'react';
import type { ApprovalHost } from '@/components/ApprovalHost';
import { MarkdownContent } from '@/components/MarkdownContent';
import { knownCatName, ShellCatAvatar, UNKNOWN_CAT_NAME } from '@/components/shell/ShellCatAvatar';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import { ProposalCardDetails } from './ProposalCardDetails';
import { ProposalChoice } from './ProposalChoice';
import { ProposalGroupChoice } from './ProposalGroupChoice';
import { ProposalReplacementLink } from './ProposalReplacementLink';
import { proposalCardCopy } from './proposal-card.shell-copy';
import styles from './proposal-card-v2.module.css';
import { proposalResultCopy } from './proposal-result.shell-copy';
import { ThreadProposalResult } from './ThreadProposalResult';
import type { ProposalCardState } from './useProposalCardState';
import { useProposalRevision } from './useProposalRevision';

/** V2 Chat and Inbox share both this presentation and the original guarded approval writer. */
export function ProposalCardV2({
  proposal,
  state,
  host,
}: {
  proposal: ThreadProposal;
  state: ProposalCardState;
  host: ApprovalHost;
}) {
  const t = useShellCopy(proposalCardCopy);
  const resultCopy = useShellCopy(proposalResultCopy);
  const { cats, getCatById } = useCatData();
  const { currentThread } = useThreadDisplayInfo(proposal.sourceThreadId);
  const sidebarRows = useSidebarProjectionStore((state) => state.rows);
  const proposer = knownCatName(proposal.sourceCatId, getCatById) ?? UNKNOWN_CAT_NAME;
  const revision = useProposalRevision(proposal, {
    suggestedGroupId: state.attentionGroupId || null,
    projectPath: state.edits.projectPath || proposal.projectPath,
    pinned: state.pinOnApprove,
  });
  const instruction = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.editing) instruction.current?.focus();
  }, [state.editing]);
  const editingBlocked = state.loading || revision.sending;
  const blocked = state.writeBlocked || revision.sending;
  const terminal = state.status === 'approved' || state.status === 'rejected' || state.status === 'withdrawn';
  useEffect(() => {
    // The mobile shell need not mount a sidebar; project choices own their canonical read.
    if (state.status === 'pending') void refreshSidebarThreadSnapshot();
  }, [state.status]);
  const projects = [
    ...new Set([
      proposal.projectPath,
      ...sidebarRows.map((row) => row.projectPath).filter((path) => path && path !== 'default'),
    ]),
  ];
  const reason = proposal.groupSuggestionReason;
  const names = proposal.preferredCats.map((id) => knownCatName(id, getCatById) ?? UNKNOWN_CAT_NAME);
  const handles = [
    ...(cats ?? []).flatMap((cat) => [
      `@${cat.id}`,
      ...(cat.mentionPatterns ?? []).map((handle) => (handle.startsWith('@') ? handle : `@${handle}`)),
    ]),
    ...proposal.preferredCats.map((id) => `@${id}`),
  ];
  const messageBody = proposal.preferredCats.length
    ? stripProposalLeadingMentions(proposal.initialMessage ?? '', handles)
    : (proposal.initialMessage ?? '');
  if (terminal)
    return (
      <article data-testid={`approval-item-${proposal.proposalId}`}>
        <ThreadProposalResult
          status={state.status as 'approved' | 'rejected' | 'withdrawn'}
          decidedAt={proposal.rejectedAt ?? proposal.withdrawnAt}
          threadId={state.resultThreadId}
          openLocked={host.writesLocked}
          authorizeOpen={() => host.authorizeWrite('producer-card', { continuation: true })}
          superseded={Boolean(proposal.supersededByProposalId)}
          replacementAction={
            proposal.supersededByProposalId ? <ProposalReplacementLink proposal={proposal} host={host} /> : undefined
          }
        >
          <h3>{proposal.title}</h3>
          <p>
            {resultCopy.proposer}: {proposer}
          </p>
          <ProposalCardDetails
            proposal={proposal}
            workMode={state.effectiveDeclaredWorkMode || undefined}
            reportingMode={state.effectiveReportingMode}
          />
          {host.originalPlaceAction}
        </ThreadProposalResult>
        {state.error ? <output className={styles.notice}>{state.error}</output> : null}
      </article>
    );
  return (
    <article className={styles.card} data-testid={`approval-item-${proposal.proposalId}`}>
      <header className={styles.header}>
        <h3>{proposal.title}</h3>
        <div className={styles.reason}>
          {t.sourcePrefix}
          {currentThread?.title || t.parentUnavailable}
          {t.sourceSuffix} · {proposal.reason}
        </div>
      </header>
      <dl className={styles.fields}>
        <dt>{t.assigned}</dt>
        <dd className={styles.cats}>
          {proposal.preferredCats.length
            ? proposal.preferredCats.map((id, index) => (
                <span key={id} className={styles.cat}>
                  <ShellCatAvatar catId={id} size={20} />
                  {names[index]}
                  {index === 0 ? <span className={styles.first}>{t.first}</span> : null}
                </span>
              ))
            : t.unspecified}
        </dd>
        <dt>
          <label htmlFor={`project-${proposal.proposalId}`}>{t.project}</label>
        </dt>
        <dd>
          <ProposalChoice
            id={`project-${proposal.proposalId}`}
            label={t.project}
            disabled={editingBlocked}
            value={state.edits.projectPath || 'default'}
            onChange={(value) =>
              state.setEdits((edits) => ({
                ...edits,
                projectPath: value === 'default' ? '' : value,
              }))
            }
            options={projects.map((project) => ({
              value: project,
              label: project === 'default' ? t.unclassified : (project.split('/').filter(Boolean).at(-1) ?? project),
            }))}
          />
        </dd>
        <dt>{t.group}</dt>
        <dd className={styles.group}>
          <ProposalGroupChoice
            value={state.attentionGroupId}
            onChange={state.setAttentionGroupId}
            disabled={editingBlocked}
          />
          {reason && reason !== 'none' && state.attentionGroupId === (proposal.suggestedGroupId ?? '') ? (
            <span className={styles.why}>{t.groupReason[reason]}</span>
          ) : null}
        </dd>
        <dt>{t.report}</dt>
        <dd>{t.reportingMode[state.effectiveReportingMode]}</dd>
        <dt>
          <label htmlFor={`pin-${proposal.proposalId}`}>{t.pinned}</label>
        </dt>
        <dd>
          <input
            id={`pin-${proposal.proposalId}`}
            aria-label={t.pinned}
            type="checkbox"
            role="switch"
            aria-checked={state.pinOnApprove}
            className={styles.switch}
            checked={state.pinOnApprove}
            disabled={editingBlocked}
            onChange={(event) => state.setPinOnApprove(event.target.checked)}
          />
        </dd>
      </dl>
      <details open className={styles.message} data-testid="proposal-initial-message">
        <summary>{t.firstMessage}</summary>
        {names.length ? (
          <span className={styles.auto} data-testid="proposal-auto-mentions">
            {names.map((name) => `@${name}`).join(' ')}
          </span>
        ) : null}
        {messageBody ? (
          <section
            className={styles.body}
            aria-label={t.firstMessage}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded first-message text supports keyboard scrolling
            tabIndex={0}
          >
            <MarkdownContent content={messageBody} className="!text-[13px] [&_p]:mb-0" disableCommandPrefix />
          </section>
        ) : null}
      </details>
      {state.status === 'pending' ? (
        <>
          <footer className={styles.footer} data-testid="proposal-actions">
            <button
              type="button"
              className={styles.primary}
              disabled={blocked}
              data-testid="approve-btn"
              onClick={state.approve}
            >
              {state.loading ? t.submitting : t.agree}
            </button>
            <button type="button" disabled={blocked} data-testid="reject-btn" onClick={state.reject}>
              {host.decisionWords?.reject ?? t.reject}
            </button>
            <button
              type="button"
              className={styles.revise}
              disabled={editingBlocked || revision.sent}
              aria-expanded={state.editing}
              onClick={() => state.setEditing(!state.editing)}
            >
              {t.askPrefix}
              {proposer}
              {t.askSuffix}
            </button>
          </footer>
          {state.editing && !revision.sent ? (
            <form
              className={styles.ask}
              onSubmit={(event) => {
                event.preventDefault();
                if (!blocked) void revision.send();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  state.setEditing(false);
                }
              }}
            >
              <input
                ref={instruction}
                aria-label={t.instruction}
                placeholder={t.instruction}
                value={revision.instruction}
                disabled={editingBlocked}
                maxLength={2000}
                onChange={(event) => revision.setInstruction(event.target.value)}
              />
              <button type="submit" className={styles.primary} disabled={blocked || !revision.instruction.trim()}>
                {t.sendPrefix}
                {proposer}
                {t.sendSuffix}
              </button>
            </form>
          ) : null}
          {revision.sent ? <output className={styles.notice}>{t.revisionSent}</output> : null}
          {host.originalPlaceAction ? <div className={styles.notice}>{host.originalPlaceAction}</div> : null}
        </>
      ) : (
        <output className={styles.notice}>{t.submitting}</output>
      )}
      {state.error || revision.error ? (
        <output className={styles.notice} role="alert">
          {state.error || revision.error}
        </output>
      ) : null}
    </article>
  );
}
