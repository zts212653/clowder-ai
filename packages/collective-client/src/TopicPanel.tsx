import { TopicMessage } from './ChannelMessage.js';
import { Composer } from './Composer.js';
import { actorDisplayName } from './channel-model.js';
import type { ChannelThread, DeliveryState } from './client-types.js';

export function TopicPanel({
  thread,
  delivery,
  onClose,
  onSend,
}: {
  readonly thread: ChannelThread;
  readonly delivery: DeliveryState;
  readonly onClose: () => void;
  readonly onSend: (body: string) => Promise<void>;
}) {
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
      <Composer
        compact
        placeholder={`回复 ${actorDisplayName(thread.root)}`}
        context="回复会留在这个话题里，频道仍保留在中间"
        delivery={delivery}
        onSend={onSend}
      />
    </aside>
  );
}
