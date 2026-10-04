import { ChannelMessage } from '../ChannelMessage.js';
import { CollectiveWorkCard } from '../CollectiveWorkCard.js';
import type { CollectiveParticipant } from '../client-types.js';
import { TopicMessage } from '../TopicMessage.js';
import { firstEntryDemo } from './demo-events.js';

export function DemoPlayback({
  beat,
  narrator,
  humanName,
  presentation,
}: {
  readonly beat: number;
  readonly narrator: CollectiveParticipant;
  readonly humanName: string;
  /** Overrides the frame default (tests, previews). */
  readonly presentation?: 'v2' | 'classic';
}) {
  if (beat === 0) return null;
  const demo = firstEntryDemo(narrator, humanName);
  return (
    <section className="journey-demo-thread" data-demo="conversation" data-guide-thread aria-label="演示对话，不会发送">
      {beat === 1 && (
        <>
          <span className="journey-demo-label">演示 · 不会发送</span>
          <ChannelMessage
            thread={{ root: demo.root, replies: [] }}
            participants={demo.participants}
            currentHumanId={narrator.humanId}
            presentation={presentation}
            onOpenTopic={() => undefined}
            onMention={() => undefined}
            onOpenMember={() => undefined}
          />
          <div className="journey-demo-replies">
            <TopicMessage
              event={demo.firstReply}
              participants={demo.participants}
              currentHumanId={narrator.humanId}
              presentation={presentation}
            />
          </div>
        </>
      )}
      {beat === 2 && (
        <div className="journey-demo-replies">
          <div className="journey-demo-neighbor" data-guide-neighbor>
            <span className="journey-demo-label">演示 · 不会发送</span>
            <p>示例 · 另一家 Café</p>
            <TopicMessage event={demo.neighborAsk} currentHumanId={narrator.humanId} presentation={presentation} />
            <TopicMessage
              event={demo.neighborReply}
              participants={demo.participants}
              currentHumanId={narrator.humanId}
              presentation={presentation}
            />
          </div>
        </div>
      )}
      {beat === 3 && (
        <div data-guide-work className="journey-demo-work">
          <span className="journey-demo-label">演示 · 不会发送</span>
          <CollectiveWorkCard
            work={demo.work}
            works={[demo.work]}
            currentHumanId={narrator.humanId}
            sourceOwnerHumanId={narrator.humanId}
            canSteward
            participants={demo.participants}
            humanNames={{ [narrator.humanId]: humanName }}
            onCommit={() => undefined}
            onDecline={() => undefined}
            onAcceptResult={() => undefined}
            onRequestRevision={async () => undefined}
            onComplete={() => undefined}
          />
        </div>
      )}
    </section>
  );
}
