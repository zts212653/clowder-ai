import { useMemo, useState } from 'react';
import { ChannelMessage } from './ChannelMessage.js';
import { Composer } from './Composer.js';
import { actorId, actorTarget, groupChannelThreads, targetLabel } from './channel-model.js';
import type {
  ClientTarget,
  CollectiveEventEnvelope,
  CollectiveMembership,
  CollectiveTarget,
  DeliveryState,
} from './client-types.js';
import { TopicPanel } from './TopicPanel.js';

export function ChannelScene({
  collective,
  humanName,
  events,
  connection,
  delivery,
  onSend,
}: {
  readonly collective: CollectiveMembership;
  readonly humanName: string;
  readonly events: readonly CollectiveEventEnvelope[];
  readonly connection: 'online' | 'offline';
  readonly delivery: DeliveryState;
  readonly onSend: (body: string, destination: ClientTarget) => Promise<void>;
}) {
  const threads = useMemo(() => groupChannelThreads(events), [events]);
  const [topicRootId, setTopicRootId] = useState<string>();
  const [target, setTarget] = useState<CollectiveTarget>({ kind: 'channel', channelId: 'general' });
  const topic = threads.find((thread) => thread.root.eventId === topicRootId);
  const distinctActors = new Set(events.map((event) => actorId(event))).size;

  const mention = (event: CollectiveEventEnvelope) => {
    setTopicRootId(undefined);
    setTarget(actorTarget(event));
  };

  return (
    <div className="scene-layout" data-context-open={topic ? 'true' : 'false'}>
      <section className="channel-scene" aria-label="# general">
        <header className="scene-header">
          <div>
            <p className="scene-eyebrow">{collective.name}</p>
            <h1># general</h1>
            <p>人和猫在同一个共同现场里说话、回应，也可以保持沉默。</p>
          </div>
          <div className="presence-summary">
            <span data-status={connection} />
            <strong>{connection === 'online' ? `${Math.max(distinctActors, 1)} 位成员留下过脚印` : '暂时离线'}</strong>
            <small>{humanName} 以本人身份进入</small>
          </div>
        </header>

        <div className="channel-flow" aria-live="polite">
          {threads.length === 0 ? (
            <div className="channel-empty">
              <h2>这里还很安静</h2>
              <p>第一句话会直接进入共同现场，不会自动变成任务，也不会假装已经有人接住。</p>
            </div>
          ) : (
            threads.map((thread) => (
              <ChannelMessage
                key={thread.root.eventId}
                thread={thread}
                onOpenTopic={setTopicRootId}
                onMention={mention}
              />
            ))
          )}
        </div>

        <Composer
          placeholder="发消息到 # general"
          context={targetLabel(target) ? `提到 @${targetLabel(target)}` : undefined}
          delivery={delivery}
          onClearContext={() => setTarget({ kind: 'channel', channelId: 'general' })}
          onSend={async (body) => {
            await onSend(body, { target });
            setTarget({ kind: 'channel', channelId: 'general' });
          }}
        />
      </section>

      {topic && (
        <TopicPanel
          thread={topic}
          delivery={delivery}
          onClose={() => setTopicRootId(undefined)}
          onSend={(body) =>
            onSend(body, {
              target: { kind: 'message', eventId: topic.root.eventId },
              replyToEventId: topic.root.eventId,
            })
          }
        />
      )}
    </div>
  );
}
