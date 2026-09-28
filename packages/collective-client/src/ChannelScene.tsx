import { useMemo, useState } from 'react';
import { ChannelMessage, TopicMessage } from './ChannelMessage.js';
import { Composer } from './Composer.js';
import { actorId, groupChannelThreads } from './channel-model.js';
import type {
  ClientTarget,
  CollectiveEventEnvelope,
  CollectiveMembership,
  CollectiveParticipant,
  CollectiveRecipient,
  DeliveryState,
} from './client-types.js';
import { ParticipantPicker, participantRecipient } from './ParticipantPicker.js';
import { TopicPanel } from './TopicPanel.js';

export function ChannelScene({
  collective,
  humanName,
  events,
  participants = [],
  connection,
  delivery,
  error,
  onSend,
}: {
  readonly collective: CollectiveMembership;
  readonly humanName: string;
  readonly events: readonly CollectiveEventEnvelope[];
  readonly participants?: readonly CollectiveParticipant[];
  readonly connection: 'online' | 'offline';
  readonly delivery: DeliveryState;
  readonly error?: string;
  readonly onSend: (body: string, destination: ClientTarget) => Promise<void>;
}) {
  const [channelId, setChannelId] = useState('general');
  const [topicRootId, setTopicRootId] = useState<string>();
  const [recipient, setRecipient] = useState<CollectiveRecipient>({ kind: 'channel' });
  const [entrust, setEntrust] = useState(false);
  const [selectionError, setSelectionError] = useState<string>();
  const channels = [
    ...new Set([
      'general',
      ...events.flatMap((event) => (event.location ? [event.location.channelId] : [])),
      ...participants.flatMap((item) => item.channelIds),
    ]),
  ];
  const scopedEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          event.location?.channelId === channelId ||
          (!event.location && event.target.kind === 'channel' && event.target.channelId === channelId),
      ),
    [events, channelId],
  );
  const threads = useMemo(() => groupChannelThreads(scopedEvents), [scopedEvents]);
  const topic = threads.find((thread) => thread.root.eventId === topicRootId);
  const distinctActors = new Set(scopedEvents.map(actorId)).size;
  const legacy = events.filter((event) => !event.location && event.target.kind !== 'channel');
  const select = (next: CollectiveRecipient) => {
    setRecipient(next);
    setEntrust(false);
    setSelectionError(undefined);
  };
  const mention = (event: CollectiveEventEnvelope) => {
    setTopicRootId(undefined);
    if (event.actor.kind === 'human') {
      select({ kind: 'human', humanId: event.actor.humanId });
      return;
    }
    const actor = event.actor;
    const participant = participants.find(
      (item) =>
        item.connectionId === actor.provenance.connectionId &&
        item.catId === actor.provenance.catId &&
        item.availability === 'declared' &&
        item.channelIds.includes(channelId),
    );
    if (!participant) {
      setSelectionError('这只猫当前未在本频道参与。');
      return;
    }
    select(participantRecipient(participant));
  };
  return (
    <div className="scene-layout" data-context-open={topic ? 'true' : 'false'}>
      <section className="channel-scene" aria-label={`# ${channelId}`}>
        <header className="scene-header">
          <div>
            <p className="scene-eyebrow">{collective.name}</p>
            <h1># {channelId}</h1>
            {channels.length > 1 && (
              <label className="channel-selector">
                频道{' '}
                <select
                  aria-label="选择频道"
                  value={channelId}
                  onChange={(event) => {
                    setChannelId(event.target.value);
                    setTopicRootId(undefined);
                    select({ kind: 'channel' });
                  }}
                >
                  {channels.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
            )}
            <p>人和猫一起回应，也可以保持沉默。</p>
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
              <p>发一句话，或选择一只已加入的猫来回应。</p>
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
          {legacy.length > 0 && (
            <details className="legacy-history">
              <summary>早期记录 · 位置尚未确认</summary>
              {legacy.map((event) => (
                <TopicMessage key={event.eventId} event={event} />
              ))}
            </details>
          )}
        </div>
        {(error || selectionError) && (
          <p role="alert" className="delivery-state delivery-failed">
            {selectionError ?? error}
          </p>
        )}
        <Composer
          key={channelId}
          placeholder={`发消息到 # ${channelId}`}
          delivery={delivery}
          onSend={(body) =>
            onSend(body, {
              location: { channelId },
              recipient,
              ...(entrust && recipient.kind === 'agent' ? { workRequest: 'entrust' } : {}),
            })
          }
        >
          <ParticipantPicker
            participants={participants}
            channelId={channelId}
            recipient={recipient}
            onChange={select}
          />
          {recipient.kind === 'agent' && (
            <label className="entrust-choice">
              <input type="checkbox" checked={entrust} onChange={(event) => setEntrust(event.target.checked)} />
              请求持续处理，并把结果带回这里<small>私人执行依猫的主人授权；发出请求不代表已接手。</small>
            </label>
          )}
        </Composer>
      </section>
      {topic && (
        <TopicPanel
          key={topic.root.eventId}
          thread={topic}
          participants={participants}
          delivery={delivery}
          onClose={() => setTopicRootId(undefined)}
          onSend={onSend}
        />
      )}
    </div>
  );
}
