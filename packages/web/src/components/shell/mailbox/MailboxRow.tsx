import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useId, useSyncExternalStore } from 'react';
import { reviewDecisionCopy } from '@/components/content-review/review-decision.shell-copy';
import { memoryCorrectionCopy } from '@/components/memory/page/memory-correction.shell-copy';
import { isCorrectionRecoveryProjection } from '@/components/memory/page/read-correction-approval';
import { ApprovalMember } from '@/components/rich/ApprovalMember';
import { conversationDecisionCopy } from '@/components/rich/conversation-decision.shell-copy';
import { isDomainApprovalFeature } from '@/components/rich/DomainApprovalCard';
import { domainApprovalCopy } from '@/components/rich/domain-approval.shell-copy';
import { evalRepairCopy } from '@/components/rich/eval-repair.shell-copy';
import { isScheduleRecoveryProjection } from '@/components/rich/read-schedule-approval';
import { scheduleApprovalCopy } from '@/components/rich/schedule-approval.shell-copy';
import { personMemoryCopy } from '../../rich/person-memory.shell-copy';
import { ShellCatAvatar } from '../ShellCatAvatar';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { describeReconcile } from './approval-reconcile';
import { type ApprovalSessions, sessionKey } from './approval-sessions';
import { MailboxItemPersonalAction } from './MailboxItemPersonalAction';
import { MailboxRowBody } from './MailboxRowBody';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { readMailboxReviewSource } from './mailbox-review-match';
import { useMailboxRowText } from './mailbox-row-text';
import { mailboxRuntimeCopy } from './mailbox-runtime.shell-copy';
import { originalApprovalCopy } from './original-approval.shell-copy';
import { originalApprovalSource } from './original-approval-card-source';
import { type OriginalPlace, resolveOriginalPlace } from './original-place';
import { PlaceAction } from './PlaceAction';
import type { ApprovalAddress } from './read-evidence';
import type { MailboxPersonalActions } from './use-mailbox-personal-preferences';

export const KIND_LABEL: Record<UnifiedAttentionItemV1['kind'], string> = mailboxEntryCopy.zh.kinds;

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block"
      style={{
        color: 'var(--shell-muted)',
        transform: open ? 'rotate(90deg)' : undefined,
        transition: 'transform 120ms',
      }}
    >
      ›
    </span>
  );
}

type Hosted = { sessions: ApprovalSessions; ownerUserId: string };

function SessionLineText({ hosted, approval }: { hosted: Hosted; approval: ApprovalAddress }) {
  const t = useShellCopy(mailboxEntryCopy);
  const { sessions, ownerUserId } = hosted;
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const key = sessionKey(ownerUserId, approval);
  const session = sessions.get(key);
  const language = useShellLanguage();
  const view = session
    ? describeReconcile(session.model.state, {
        language,
        ownerUserId,
        sourceFeatureId: approval.sourceFeatureId,
      })
    : null;
  if (!view?.line) return null;
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <output
        className="m-0 block flex-1 text-xs font-medium"
        style={{ color: 'var(--shell-body)' }}
        data-testid="mailbox-row-session-line"
      >
        {view.line}
      </output>
      {view.canReread ? (
        <button
          type="button"
          data-testid="mailbox-row-reread"
          onClick={() => sessions.reread(key)}
          className="shell-nav-row shell-focusable flex-none rounded-lg px-2 py-1 text-xs"
        >
          {t.reread}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Where a row's decision stands, when the row is closed or from the previous read. An in-flight write, an unknown or a result
 * is never shown as nothing; a row nobody has acted on says nothing here. An open row's card says it itself.
 */
function RowSessionLine({
  open,
  hosted,
  approval,
}: {
  open: boolean;
  hosted: Hosted | undefined;
  approval: ApprovalAddress | undefined;
}) {
  if (open || !hosted || !approval) return null;
  return <SessionLineText hosted={hosted} approval={approval} />;
}

/**
 * One 待办 item. Collapsed it is a line; expanded (one at a time) it says what the read carries and offers exactly one
 * way forward: open the place that owns the decision. A row from a previous read is never interactive.
 */
export function MailboxRow({
  item,
  rowKey,
  stale,
  expanded,
  onToggle,
  onOpen,
  hosted,
  personal,
  readCurrent = !stale,
}: {
  item: UnifiedAttentionItemV1;
  rowKey: string;
  stale: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (place: OriginalPlace) => void;
  /** Where decisions made on a row's original card are followed, and whose they are. Absent: the row only points to the place. */
  hosted?: Hosted;
  personal?: MailboxPersonalActions;
  readCurrent?: boolean;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const conversationCopy = useShellCopy(conversationDecisionCopy);
  const runtimeCopy = useShellCopy(mailboxRuntimeCopy);
  const runtimeKind =
    item.runtimeInteraction?.sourceKind === 'conversation_decision'
      ? conversationCopy.kind
      : runtimeCopy.kind[item.runtimeInteraction?.kind ?? (item.choiceRequest ? 'question' : 'unknown')];
  const reviewCopy = useShellCopy(reviewDecisionCopy);
  const originalCopy = useShellCopy(originalApprovalCopy);
  const domainCopy = useShellCopy(domainApprovalCopy);
  const correctionCopy = useShellCopy(memoryCorrectionCopy);
  const scheduleCopy = useShellCopy(scheduleApprovalCopy);
  const repairCopy = useShellCopy(evalRepairCopy);
  const personCopy = useShellCopy(personMemoryCopy);
  const bodyId = useId();
  const { catId, lead, title, source, time } = useMailboxRowText(item);
  const heading = lead ? `${lead} ${title}` : title;
  const session =
    hosted && item.approval ? hosted.sessions.get(sessionKey(hosted.ownerUserId, item.approval)) : undefined;
  const retainingDecision = session !== undefined && session.model.state.kind !== 'idle';
  const open = expanded && (!stale || retainingDecision);
  const nativeProposal =
    hosted !== undefined && item.approval?.sourceFeatureId === 'F128' && !item.approval.inlineApprovable;
  const nativeOriginal = Boolean(hosted && originalApprovalSource(item));
  const originalKind = item.approval?.sourceFeatureId === 'F225' ? originalCopy.kind.F225 : originalCopy.kind.F231;
  const nativeRuntime = Boolean(hosted && (item.runtimeInteraction || item.choiceRequest));
  const nativeReview = Boolean(hosted && readMailboxReviewSource(item, hosted.ownerUserId));
  const domainFeature = item.approval?.sourceFeatureId;
  const nativeDomain = hosted && domainFeature && isDomainApprovalFeature(domainFeature) ? domainFeature : null;
  const nativeCorrection = Boolean(hosted && domainFeature === 'F321');
  const nativeSchedule = Boolean(hosted && domainFeature === 'F139');
  const nativeRepair = Boolean(hosted && domainFeature === 'F266');
  const nativePerson = Boolean(hosted && domainFeature === 'F276');
  const nativeCanonical = Boolean(nativeDomain || nativeCorrection || nativeSchedule || nativeRepair || nativePerson);
  return (
    <li
      data-testid="mailbox-item"
      data-kind-label={
        item.collectiveAccountabilityRequest
          ? t.accountabilityKind
          : nativePerson
            ? personCopy.kind
            : nativeRepair
              ? repairCopy.kind
              : nativeSchedule
                ? scheduleCopy.kind
                : nativeCorrection
                  ? correctionCopy.kind
                  : nativeDomain
                    ? domainCopy.kind[nativeDomain]
                    : nativeOriginal
                      ? originalKind
                      : nativeReview
                        ? reviewCopy.kind
                        : item.choiceRequest || nativeRuntime
                          ? runtimeKind
                          : t.kinds[item.kind]
      }
      data-row-key={rowKey}
      data-stale={stale ? 'true' : undefined}
      data-expanded={open ? 'true' : 'false'}
      className="rounded-[14px]"
      style={{
        opacity: stale ? 0.6 : undefined,
        border: `1px solid ${open ? 'var(--shell-hairline-strong)' : 'var(--shell-hairline)'}`,
        background: item.userMention ? 'var(--shell-work)' : 'var(--shell-paper)',
      }}
    >
      <div className={item.userMention && personal ? 'flex items-start gap-2 px-3 py-3' : undefined}>
        {nativeCanonical ? null : nativeProposal || nativeReview || nativeRuntime || nativeOriginal ? (
          <div className="space-y-2 px-3 pt-3 text-sm">
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              style={{ color: 'var(--shell-muted)' }}
            >
              <span>
                {nativeOriginal
                  ? originalKind
                  : nativeReview
                    ? reviewCopy.kind
                    : nativeRuntime
                      ? runtimeKind
                      : t.newConversation}
              </span>
              {catId ? <ApprovalMember catId={catId} /> : null}
              {time ? <time className="ml-auto flex-none whitespace-nowrap">{time}</time> : null}
            </div>
            {nativeProposal ? (
              <p className="m-0 break-words font-medium" data-testid="mailbox-item-title">
                {title}
              </p>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            data-testid="mailbox-item-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            disabled={stale}
            onClick={onToggle}
            className={`shell-nav-row shell-focusable flex min-w-0 flex-1 flex-col gap-1.5 rounded-[14px] text-left text-sm ${item.userMention && personal ? '' : 'w-full px-4 py-3'}`}
          >
            {item.userMention ? (
              <>
                <span className="flex w-full items-start gap-2">
                  {catId ? (
                    <span className="mt-px flex-none" data-testid="mailbox-item-avatar">
                      <ShellCatAvatar catId={catId} size={24} />
                    </span>
                  ) : null}
                  <span
                    data-testid="mailbox-mention-preview"
                    className="line-clamp-2 min-w-0 break-words text-sm"
                    style={{ color: 'var(--shell-body)' }}
                  >
                    {source}：{item.userMention.content}
                  </span>
                </span>
                <span
                  className="flex w-full min-w-0 items-center gap-2 pl-8 text-xs"
                  style={{ color: 'var(--shell-muted)' }}
                >
                  <span className={`min-w-0 flex-1 ${open ? 'break-words' : 'truncate'}`}>{title}</span>
                  {item.userMention.handled && item.userMention.handledReason ? (
                    <span className="flex-none whitespace-nowrap" data-testid="mailbox-mention-handled-reason">
                      {t.mentionHandledReasons[item.userMention.handledReason]}
                    </span>
                  ) : null}
                  {time && !personal ? <time className="flex-none whitespace-nowrap">{time}</time> : null}
                  <Chevron open={open} />
                </span>
              </>
            ) : (
              <>
                <span className="flex w-full items-center gap-2">
                  <span
                    className="flex-none rounded px-1.5 text-micro"
                    style={{ background: 'var(--shell-selected)', color: 'var(--shell-muted)' }}
                  >
                    {item.choiceRequest || nativeRuntime ? runtimeKind : t.kinds[item.kind]}
                  </span>
                  <span className="flex-1" />
                  {time ? (
                    <span className="text-xs" style={{ color: 'var(--shell-muted)' }}>
                      {time}
                    </span>
                  ) : null}
                  <Chevron open={open} />
                </span>
                <span className="flex w-full items-start gap-2">
                  {catId ? (
                    <span className="mt-px flex-none" data-testid="mailbox-item-avatar">
                      <ShellCatAvatar catId={catId} size={24} />
                    </span>
                  ) : null}
                  <span className={`${open ? 'block' : 'line-clamp-2 block'} min-w-0 flex-1`}>
                    {lead ? <span className="font-semibold">{lead} </span> : null}
                    {title}
                  </span>
                </span>
                {source ? (
                  <span className="block truncate text-xs" style={{ color: 'var(--shell-muted)' }}>
                    {source}
                  </span>
                ) : null}
              </>
            )}
          </button>
        )}
        {item.userMention && personal ? (
          <div className="flex flex-none flex-col items-end gap-1.5" data-testid="mailbox-row-actions">
            <div className="flex items-center gap-1">
              <MailboxItemPersonalAction item={item} personal={personal} />
              <PlaceAction quiet compact place={resolveOriginalPlace(item)} onOpen={onOpen} />
            </div>
            {time ? (
              <time className="whitespace-nowrap text-xs" style={{ color: 'var(--shell-muted)' }}>
                {time}
              </time>
            ) : null}
          </div>
        ) : null}
      </div>
      {item.approval &&
      (isScheduleRecoveryProjection(item.approval) || isCorrectionRecoveryProjection(item.approval)) ? null : (
        <RowSessionLine
          open={open || nativeProposal || nativeReview || nativeRuntime || nativeOriginal || nativeCanonical}
          hosted={hosted}
          approval={item.approval}
        />
      )}
      {open || nativeProposal || nativeReview || nativeRuntime || nativeOriginal || nativeCanonical ? (
        <MailboxRowBody
          item={item}
          id={bodyId}
          heading={heading}
          hosted={hosted}
          personal={personal}
          readCurrent={readCurrent}
          onOpen={onOpen}
        />
      ) : null}
    </li>
  );
}
