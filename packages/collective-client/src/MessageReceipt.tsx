import type { CollectiveEventEnvelope, CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { useCollectiveText } from './collective-copy.js';
import { participantLabel } from './participant-label.js';

/** A public reply proves only its own source × recipient. An online participant proves no delivery or execution. */
export function MessageReceipt({
  event,
  replies,
  participants,
  works,
  onOpen,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly replies: readonly CollectiveEventEnvelope[];
  readonly participants: readonly CollectiveParticipant[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly onOpen: (eventId: string) => void;
}) {
  const t = useCollectiveText();
  const recipient = event.recipient;
  if (recipient?.kind !== 'agent') return null;
  const cat = participants.find(
    (p) =>
      p.serviceInstanceId === event.serviceInstanceId &&
      p.collectiveId === event.collectiveId &&
      p.connectionId === recipient.connectionId &&
      p.humanId === recipient.humanId &&
      p.catId === recipient.agentId,
  );
  const response = replies.find(
    (reply) =>
      reply.actor.kind === 'agent' &&
      reply.serviceInstanceId === event.serviceInstanceId &&
      reply.collectiveId === event.collectiveId &&
      reply.actor.human.humanId === recipient.humanId &&
      reply.actor.provenance.connectionId === recipient.connectionId &&
      reply.actor.provenance.catId === recipient.agentId &&
      (reply.replyToEventId === event.eventId || reply.location?.rootEventId === event.eventId),
  );
  const work = works.find(
    (w) =>
      w.sourceEventId === event.eventId &&
      w.assignment?.connectionId === recipient.connectionId &&
      w.assignment.catId === recipient.agentId &&
      w.assignment.humanId === recipient.humanId,
  );
  const label = response
    ? '已回复'
    : work?.status === 'result_ready'
      ? '已交回结果'
      : work?.status === 'in_progress'
        ? '推进中'
        : work?.status === 'blocked'
          ? '等待依赖'
          : work?.lifecycle === 'committed'
            ? '已接下'
            : '回应状态待确认';
  return (
    <div className="message-receipt" role="status" data-recipient-id={recipient.agentId}>
      <span className="receipt-status" data-host-ui-slot="receipt" data-source-event-id={event.eventId}>
        <span className="receipt-dot" data-state={response ? 'done' : (work?.status ?? 'unknown')} aria-hidden="true" />
        <span>
          {cat ? participantLabel(cat, participants) : recipient.agentId} · {t(label)}
        </span>
      </span>
      {(response || work?.resultEventId) && (
        <button type="button" onClick={() => onOpen(response?.eventId ?? work?.resultEventId ?? event.eventId)}>
          {t('查看回复')}
        </button>
      )}
    </div>
  );
}
