import { useState } from 'react';
import { TopicMessage } from './ChannelMessage.js';
import { Composer } from './Composer.js';
import { actorDisplayName } from './channel-model.js';
import type {
  ChannelThread,
  ClientTarget,
  CollectiveParticipant,
  CollectiveRecipient,
  DeliveryState,
} from './client-types.js';
import { ParticipantPicker } from './ParticipantPicker.js';

export function TopicPanel({
  thread,
  delivery,
  onClose,
  onSend,
  participants,
}: {
  readonly thread: ChannelThread;
  readonly delivery: DeliveryState;
  readonly onClose: () => void;
  readonly onSend: (body: string, target: ClientTarget) => Promise<void>;
  readonly participants: readonly CollectiveParticipant[];
}) {
  const [recipient, setRecipient] = useState<CollectiveRecipient>({ kind: 'channel' });
  const [entrust, setEntrust] = useState(false);
  const location =
    thread.root.location ??
    (thread.root.target.kind === 'channel' ? { channelId: thread.root.target.channelId } : undefined);
  return (
    <aside className="context-panel" data-spatial-role="context-panel" aria-label="话题">
      <header className="context-header">
        <div>
          <span>话题</span>
          <h2>{thread.replies.length} 条回复</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭话题">
          ×
        </button>
      </header>
      <div className="topic-flow">
        <TopicMessage event={thread.root} />
        <div className="topic-divider">
          <span>回应</span>
        </div>
        {thread.replies.map((reply) => (
          <TopicMessage key={reply.eventId} event={reply} />
        ))}
      </div>
      {location ? (
        <Composer
          compact
          placeholder={`回复 ${actorDisplayName(thread.root)}`}
          context="回复会留在这个话题里，频道仍保留在中间"
          delivery={delivery}
          onSend={(body) =>
            onSend(body, {
              location: { ...location, rootEventId: location.rootEventId ?? thread.root.eventId },
              recipient,
              replyToEventId: thread.root.eventId,
              ...(entrust && recipient.kind === 'agent' ? { workRequest: 'entrust' } : {}),
            })
          }
        >
          <ParticipantPicker
            participants={participants}
            channelId={location.channelId}
            recipient={recipient}
            onChange={(next) => {
              setRecipient(next);
              setEntrust(false);
            }}
          />
          {recipient.kind === 'agent' && (
            <label className="entrust-choice">
              <input type="checkbox" checked={entrust} onChange={(event) => setEntrust(event.target.checked)} />
              请求持续处理并回到此话题
            </label>
          )}
        </Composer>
      ) : (
        <p>这条早期记录的位置尚未确认，暂时无法回复。</p>
      )}
    </aside>
  );
}
