import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { isCorrectionRecoveryProjection } from '@/components/memory/page/read-correction-approval';
import { isDomainApprovalFeature } from '../../rich/DomainApprovalCard';
import { isScheduleRecoveryProjection } from '../../rich/read-schedule-approval';
import { useShellCopy } from '../shell-copy';
import { isHostableApproval } from './approval-match';
import type { ApprovalSessions } from './approval-sessions';
import { HostedApprovalCard } from './HostedApprovalCard';
import { MailboxChoiceCard } from './MailboxChoiceCard';
import { MailboxDomainApprovalCard } from './MailboxDomainApprovalCard';
import { MailboxExecutionRecoveryCard } from './MailboxExecutionRecoveryCard';
import { MailboxItemPersonalAction } from './MailboxItemPersonalAction';
import { MailboxOriginalApprovalCard } from './MailboxOriginalApprovalCard';
import { MailboxReviewCard } from './MailboxReviewCard';
import { MailboxRuntimeCard } from './MailboxRuntimeCard';
import { MailboxWorkDetails } from './MailboxWorkDetails';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { readMailboxReviewSource, sameMailboxReviewSource } from './mailbox-review-match';
import { originalApprovalSource } from './original-approval-card-source';
import { type OriginalPlace, resolveOriginalPlace } from './original-place';
import { PlaceAction } from './PlaceAction';
import { UserMentionDetails } from './UserMentionDetails';
import type { MailboxPersonalActions } from './use-mailbox-personal-preferences';

/** The opened row: what the read carries about it, and either the original card (a decidable approval) or the one way to the place. */
export function MailboxRowBody({
  item,
  id,
  heading,
  hosted,
  personal,
  readCurrent,
  onOpen,
}: {
  item: UnifiedAttentionItemV1;
  id: string;
  heading: string;
  hosted: { sessions: ApprovalSessions; ownerUserId: string } | undefined;
  personal?: MailboxPersonalActions;
  readCurrent: boolean;
  onOpen: (place: OriginalPlace) => void;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const place = resolveOriginalPlace(item);
  const hostable = hosted !== undefined && item.approval !== undefined && isHostableApproval(item.approval);
  const originalSource = hosted ? originalApprovalSource(item) : null;
  const reviewSource = hosted ? readMailboxReviewSource(item, hosted.ownerUserId) : null;
  const domain = hosted && item.approval && isDomainApprovalFeature(item.approval.sourceFeatureId);
  const executionRecovery = Boolean(
    hosted &&
      item.approval &&
      (isScheduleRecoveryProjection(item.approval) || isCorrectionRecoveryProjection(item.approval)),
  );
  return (
    <section
      id={id}
      aria-label={`${item.collectiveAccountabilityRequest ? t.accountabilityKind : item.choiceRequest ? t.choice : t.kinds[item.kind]}：${heading}`}
      data-testid="mailbox-item-body"
      className="flex flex-col gap-3 px-3 pb-3 pt-1"
      style={{ color: 'var(--shell-ink)' }}
    >
      {item.userMention ? (
        <UserMentionDetails key={item.userMention.messageId} request={item.userMention} showHandling={!personal} />
      ) : item.approval || item.choiceRequest || item.runtimeInteraction || reviewSource ? null : (
        <MailboxWorkDetails item={item} />
      )}
      {personal &&
      !hostable &&
      !item.userMention &&
      !((item.choiceRequest || item.runtimeInteraction) && hosted) &&
      !reviewSource &&
      !domain &&
      !executionRecovery &&
      !originalSource ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <MailboxItemPersonalAction item={item} personal={personal} />
        </div>
      ) : null}
      {domain && hosted ? (
        <MailboxDomainApprovalCard
          item={item}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          readCurrent={readCurrent}
          secondaryActions={
            <>
              {personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : null}
              <PlaceAction quiet place={place} onOpen={onOpen} />
            </>
          }
        />
      ) : null}
      {originalSource && hosted ? (
        <MailboxOriginalApprovalCard
          item={item}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          readCurrent={readCurrent}
          secondaryActions={
            <>
              {personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : null}
              <PlaceAction quiet place={place} onOpen={onOpen} />
            </>
          }
        />
      ) : null}
      {reviewSource ? (
        <MailboxReviewCard
          key={`${reviewSource.ownerUserId}:${reviewSource.reviewId}`}
          source={reviewSource}
          readCurrent={readCurrent}
          verifyCurrentRead={() => {
            const item = hosted?.sessions.currentItem?.(
              reviewSource.ownerUserId,
              `f309.content_review:${reviewSource.reviewId}`,
            );
            const current = item && readMailboxReviewSource(item, reviewSource.ownerUserId);
            return Boolean(current && sameMailboxReviewSource(current, reviewSource));
          }}
          secondaryActions={
            <>
              {personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : null}
              <PlaceAction place={place} onOpen={onOpen} />
            </>
          }
        />
      ) : null}
      {item.runtimeInteraction && hosted ? (
        <MailboxRuntimeCard
          onAnswerInText={() => onOpen(place)}
          source={item.runtimeInteraction}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          readCurrent={readCurrent}
          secondaryActions={
            <>
              {personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : null}
              <PlaceAction quiet place={place} onOpen={onOpen} />
            </>
          }
        />
      ) : null}
      {item.choiceRequest && !item.runtimeInteraction && hosted ? (
        <MailboxChoiceCard
          key={`${item.choiceRequest.interactionId}:${item.choiceRequest.revision}`}
          choice={item.choiceRequest}
          ownerUserId={hosted.ownerUserId}
          readCurrent={readCurrent}
          verifyCurrentRead={() => {
            const current = hosted.sessions.currentItem?.(hosted.ownerUserId, item.decisionRef);
            return Boolean(
              current?.choiceRequest && JSON.stringify(current.choiceRequest) === JSON.stringify(item.choiceRequest),
            );
          }}
          secondaryActions={
            <div
              className="ml-auto flex flex-wrap items-center justify-end gap-2"
              data-testid="mailbox-row-secondary-actions"
            >
              {personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : null}
              <PlaceAction quiet place={place} onOpen={onOpen} />
            </div>
          }
        />
      ) : null}
      {executionRecovery && hosted ? (
        <MailboxExecutionRecoveryCard
          item={item}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          readCurrent={readCurrent}
          secondaryActions={
            <div className="ml-auto flex items-center justify-end gap-2" data-testid="mailbox-row-secondary-actions">
              {personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : null}
              <PlaceAction quiet place={place} onOpen={onOpen} />
            </div>
          }
        />
      ) : null}
      {domain || executionRecovery ? null : hostable && hosted ? (
        <HostedApprovalCard
          item={item}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          secondaryAction={personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : undefined}
          place={place}
          onOpen={onOpen}
          readCurrent={readCurrent}
        />
      ) : (item.userMention && personal) ||
        ((item.choiceRequest || item.runtimeInteraction) && hosted) ||
        reviewSource ||
        originalSource ||
        executionRecovery ? null : (
        <PlaceAction quiet={Boolean(item.approval)} place={place} onOpen={onOpen} />
      )}
    </section>
  );
}
