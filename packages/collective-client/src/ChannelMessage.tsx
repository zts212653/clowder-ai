import { actorDisplayName, actorId, actorOrigin, formatEventTime, targetLabel } from './channel-model.js';
import type { ChannelThread, CollectiveEventEnvelope } from './client-types.js';

function Avatar({ event, compact = false }: { readonly event: CollectiveEventEnvelope; readonly compact?: boolean }) {
  return (
    <span className={compact ? 'avatar avatar-compact' : 'avatar'} data-actor-kind={event.actor.kind}>
      {actorDisplayName(event).slice(0, 1).toUpperCase()}
    </span>
  );
}

function MessageBody({ event }: { readonly event: CollectiveEventEnvelope }) {
  const mention = targetLabel(event.target);
  return (
    <>
      {mention && <p className="target-line">@{mention}</p>}
      <p className="message-body">{event.body}</p>
    </>
  );
}

export function ChannelMessage({
  thread,
  onOpenTopic,
  onMention,
}: {
  readonly thread: ChannelThread;
  readonly onOpenTopic: (eventId: string) => void;
  readonly onMention: (event: CollectiveEventEnvelope) => void;
}) {
  const { root, replies } = thread;
  const preview = replies.slice(-2);
  return (
    <article className="message" data-event-id={root.eventId}>
      <button
        type="button"
        className="avatar-button"
        onClick={() => onMention(root)}
        aria-label={`提到 ${actorDisplayName(root)}`}
      >
        <Avatar event={root} />
      </button>
      <div className="message-content">
        <header className="message-meta">
          <strong>{actorDisplayName(root)}</strong>
          <span>{actorOrigin(root)}</span>
          <time dateTime={root.acceptedAt}>{formatEventTime(root.acceptedAt)}</time>
        </header>
        <MessageBody event={root} />
        {replies.length > 0 && (
          <button type="button" className="reply-vitals" onClick={() => onOpenTopic(root.eventId)}>
            <span className="reply-avatars" aria-hidden="true">
              {Array.from(new Map(replies.map((reply) => [actorId(reply), reply])).values())
                .slice(0, 3)
                .map((reply) => (
                  <Avatar key={actorId(reply)} event={reply} compact />
                ))}
            </span>
            <span>{replies.length} 条回复</span>
            <small>最近 {formatEventTime(replies.at(-1)?.acceptedAt ?? root.acceptedAt)}</small>
          </button>
        )}
        {preview.length > 0 && (
          <div className="reply-preview">
            {preview.map((reply) => (
              <p key={reply.eventId}>
                <strong>{actorDisplayName(reply)}</strong>
                <span>{reply.body}</span>
              </p>
            ))}
          </div>
        )}
        <fieldset className="message-actions" aria-label="消息动作">
          <button type="button" onClick={() => onOpenTopic(root.eventId)}>
            回复
          </button>
          <button type="button" onClick={() => onMention(root)}>
            @{actorDisplayName(root)}
          </button>
        </fieldset>
      </div>
    </article>
  );
}

export function TopicMessage({ event }: { readonly event: CollectiveEventEnvelope }) {
  return (
    <article className="topic-message">
      <Avatar event={event} compact />
      <div>
        <header className="message-meta">
          <strong>{actorDisplayName(event)}</strong>
          <time dateTime={event.acceptedAt}>{formatEventTime(event.acceptedAt)}</time>
        </header>
        <MessageBody event={event} />
      </div>
    </article>
  );
}
