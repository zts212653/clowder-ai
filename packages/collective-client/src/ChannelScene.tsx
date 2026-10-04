import { useCallback, useEffect, useRef, useState } from 'react';
import { ChannelComposer } from './ChannelComposer.js';
import { ChannelContentTabs } from './ChannelContentTabs.js';
import { ChannelConversationFlow } from './ChannelConversationFlow.js';
import { ChannelHeader } from './ChannelHeader.js';
import type { MentionSelection } from './Composer.js';
import { collaborationForChannel, roadmapActionsFor } from './channel-collaboration.js';
import { actorDisplayName, groupChannelThreads } from './channel-model.js';
import { eventChannelId } from './channel-navigation.js';
import type { ChannelSceneProps } from './channel-scene-props.js';
import type { CollectiveEventEnvelope } from './client-types.js';
import { DemoPlayback } from './first-entry/DemoPlayback.js';
import { mentionSelectionForEvent } from './participant-identity.js';
import { RoadmapWorkspace } from './RoadmapWorkspace.js';
import { TopicPanel } from './TopicPanel.js';

export function ChannelScene({
  collective,
  humanId,
  humanName,
  channelId,
  content,
  onSelectContent,
  focusEventId,
  onCloseContext,
  namespace,
  query,
  events,
  collaboration,
  participants = [],
  connection,
  delivery,
  error,
  onSend,
  onProposeWork,
  onCommitWork,
  onDeclineWork,
  onAcceptWorkResult,
  onRequestWorkRevision,
  onCompleteWork,
  onCreateRoadmap,
  onSetRoadmapWorks,
  onSetRoadmapStatus,
  roadmapView,
  onRoadmapViewChange,
  onOpenRoadmapSource,
  onOpenRoadmapResult,
  roadmapReturnLabel,
  onReturnToRoadmap,
  onCreateVote,
  onCastVote,
  onCloseVote,
  onCreateBindingVote,
  onCastBindingVote,
  onWithdrawBindingVote,
  onSettleBindingVote,
  onSetWorkDependencies,
  onSetReaction,
  onOpenNavigation,
  onOpenMember,
  onOpenTopic,
  onOpenChannel,
  context,
  onCafe,
  members,
  firstEntry,
}: ChannelSceneProps) {
  const [topicRootId, setTopicRootId] = useState<string>();
  const [replyRequest, setReplyRequest] = useState<{ eventId: string }>();
  const [mention, setMention] = useState<MentionSelection>();
  const [selectionError, setSelectionError] = useState<string>();
  const [highlightedId, setHighlightedId] = useState(focusEventId);
  const restoredScroll = useRef(false);
  const focusedHostEvent = useRef<string>();
  const searching = useRef(Boolean(query));
  searching.current = Boolean(query);
  const flowRef = useRef<HTMLDivElement>(null);
  const allThreads = groupChannelThreads(events);
  const search = query.trim().toLocaleLowerCase();
  const threads = allThreads.filter((thread) =>
    search
      ? [thread.root, ...thread.replies].some(
          (event) =>
            event.body.toLocaleLowerCase().includes(search) ||
            actorDisplayName(event).toLocaleLowerCase().includes(search),
        )
      : eventChannelId(thread.root) === channelId,
  );
  const topic = allThreads.find((thread) => thread.root.eventId === topicRootId);
  const humans = members?.humans ?? [];
  const humanNames = Object.fromEntries(humans.map((human) => [human.humanId, human.displayName]));
  const { allWorks, channelWorks, channelVotes, roadmaps, bindingVotes, decisions } = collaborationForChannel(
    collaboration,
    channelId,
  );
  const channelReactions = (collaboration?.reactions ?? []).filter((reaction) =>
    threads.some((thread) => [thread.root, ...thread.replies].some((event) => event.eventId === reaction.eventId)),
  );
  const legacy = events.filter((event) => !eventChannelId(event));
  const openTopic = (id: string, focusComposer = false) => {
    setTopicRootId(id);
    setReplyRequest(focusComposer ? { eventId: id } : undefined);
    onOpenTopic();
  };
  const returnToRoot = useCallback(
    (event: CollectiveEventEnvelope) => {
      setTopicRootId(undefined);
      setReplyRequest(undefined);
      setHighlightedId(event.eventId);
      const sourceChannel = eventChannelId(event);
      onOpenChannel?.(sourceChannel ?? channelId, event.eventId);
      requestAnimationFrame(() => {
        const source = document.getElementById(`collective-event-${event.eventId}`);
        source?.scrollIntoView({ block: 'center' });
        source?.focus({ preventScroll: true });
      });
    },
    [channelId, onOpenChannel],
  );
  useEffect(() => {
    const key = `collective-scroll:${namespace}:${channelId}`;
    const flow = flowRef.current;
    if (!flow) return;
    const save = () => {
      if (!restoredScroll.current || searching.current) return;
      try {
        window.localStorage.setItem(key, String(flow.scrollTop));
      } catch {
        /* Storage may be unavailable. */
      }
    };
    flow.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      flow.removeEventListener('scroll', save);
    };
  }, [namespace, channelId]);
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow || restoredScroll.current || !events.length || query) return;
    try {
      flow.scrollTop = Number(window.localStorage.getItem(`collective-scroll:${namespace}:${channelId}`) ?? '0');
    } catch {
      /* Unavailable storage does not prevent reading. */
    }
    restoredScroll.current = true;
  }, [namespace, channelId, events.length, query]);
  useEffect(() => {
    if (!focusEventId) {
      focusedHostEvent.current = undefined;
      return;
    }
    const focused = events.find((event) => event.eventId === focusEventId);
    const rootEventId = focused?.location?.rootEventId ?? focused?.replyToEventId;
    if (rootEventId) {
      setTopicRootId(rootEventId);
      setReplyRequest(undefined);
    } else {
      setTopicRootId(undefined);
    }
    setHighlightedId(focusEventId);
    const frame = requestAnimationFrame(() => {
      if (focusedHostEvent.current === focusEventId) return;
      const target = document.getElementById(`collective-event-${focusEventId}`);
      if (!target) return;
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
      focusedHostEvent.current = focusEventId;
    });
    return () => cancelAnimationFrame(frame);
  }, [events, focusEventId]);
  useEffect(() => {
    if (content !== 'roadmap') return;
    setTopicRootId(undefined);
    setReplyRequest(undefined);
  }, [content]);
  useEffect(() => {
    if (!context && !topic) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (topic) returnToRoot(topic.root);
        else onCloseContext?.();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [context, topic, onCloseContext, returnToRoot]);
  const requestMember = (event: CollectiveEventEnvelope) => {
    setTopicRootId(undefined);
    const result = mentionSelectionForEvent(event, participants, channelId);
    setSelectionError(result.error);
    if (result.selection) setMention(result.selection);
  };
  return (
    <div
      className="scene-layout"
      data-context-open={Boolean(context || topic)}
      data-entry-browsing={firstEntry?.phase === 'browsing'}
    >
      <section className="channel-scene" aria-label={search ? '搜索结果' : `# ${channelId}`}>
        <ChannelHeader
          collectiveName={collective.name}
          channelId={channelId}
          searchCount={search ? threads.length : undefined}
          connection={connection}
          onOpenNavigation={onOpenNavigation}
          onCafe={onCafe}
          guideCatCount={
            firstEntry?.phase === 'playing' && firstEntry.beat === 0 && firstEntry.arrivalComplete
              ? firstEntry.ownCats.length
              : undefined
          }
        />
        {!search && (
          <ChannelContentTabs
            content={content}
            hasRoadmap={roadmaps.length > 0}
            onSelect={(next) => {
              if (next === 'roadmap') {
                setTopicRootId(undefined);
                onCloseContext?.();
              }
              onSelectContent(next);
            }}
          />
        )}
        {content === 'conversation' && roadmapReturnLabel && onReturnToRoadmap && (
          <button type="button" className="roadmap-return" onClick={onReturnToRoadmap}>
            ← 返回 {roadmapReturnLabel}
          </button>
        )}
        {content === 'roadmap' && roadmaps.length ? (
          <RoadmapWorkspace
            roadmaps={roadmaps}
            works={allWorks}
            currentHumanId={humanId}
            humanNames={humanNames}
            view={roadmapView}
            onViewChange={onRoadmapViewChange}
            onOpenSource={onOpenRoadmapSource}
            onOpenResult={onOpenRoadmapResult}
            onSetDependencies={(work, dependencyWorkIds) =>
              void onSetWorkDependencies(work, dependencyWorkIds).catch(() => undefined)
            }
            onSetStatus={(roadmap, status) => void onSetRoadmapStatus(roadmap, status).catch(() => undefined)}
            bindingVotes={bindingVotes}
            decisions={decisions}
            onCreateBindingVote={onCreateBindingVote}
            onCastBindingVote={(vote, choice) => void onCastBindingVote(vote, choice).catch(() => undefined)}
            onWithdrawBindingVote={(vote) => void onWithdrawBindingVote(vote).catch(() => undefined)}
            onSettleBindingVote={(vote) => void onSettleBindingVote(vote).catch(() => undefined)}
          />
        ) : (
          <ChannelConversationFlow
            flowRef={flowRef}
            threads={threads}
            legacy={legacy}
            search={Boolean(search)}
            humanName={humanName}
            channelWorks={channelWorks}
            channelVotes={channelVotes}
            channelReactions={channelReactions}
            highlightedId={highlightedId}
            humanId={humanId}
            canSteward={collective.role === 'steward'}
            participants={participants}
            humanNames={humanNames}
            roadmaps={roadmaps}
            actions={{
              returnToRoot,
              openTopic,
              mention: requestMember,
              openMember: onOpenMember,
              proposeWork: onProposeWork,
              commitWork: onCommitWork,
              declineWork: onDeclineWork,
              acceptWorkResult: onAcceptWorkResult,
              requestWorkRevision: onRequestWorkRevision,
              completeWork: onCompleteWork,
              createVote: onCreateVote,
              castVote: onCastVote,
              closeVote: onCloseVote,
              createRoadmap: onCreateRoadmap,
              setRoadmapWorks: onSetRoadmapWorks,
              setReaction: onSetReaction,
            }}
          >
            {firstEntry?.phase === 'playing' && firstEntry.narrator && channelId === 'general' && (
              <DemoPlayback beat={firstEntry.beat} narrator={firstEntry.narrator} humanName={humanName} />
            )}
          </ChannelConversationFlow>
        )}
        {(error || selectionError) && (
          <p role="alert" className="delivery-state delivery-failed">
            {selectionError ?? error}
          </p>
        )}
        {!search && content === 'conversation' && (
          <ChannelComposer
            namespace={namespace}
            channelId={channelId}
            participants={participants}
            humans={humans}
            delivery={delivery}
            mention={mention}
            onSend={onSend}
            onCafe={onCafe}
            firstEntry={firstEntry}
          />
        )}
      </section>
      {context ||
        (topic && (
          <TopicPanel
            key={topic.root.eventId}
            namespace={namespace}
            thread={topic}
            replyRequest={replyRequest}
            humans={humans}
            participants={participants}
            delivery={delivery}
            works={channelWorks}
            votes={channelVotes}
            allWorks={channelWorks}
            currentHumanId={humanId}
            humanNames={humanNames}
            canSteward={collective.role === 'steward'}
            onOpenMember={onOpenMember}
            onClose={() => returnToRoot(topic.root)}
            onReturnToSource={() => returnToRoot(topic.root)}
            onSend={onSend}
            onProposeWork={(sourceEventId) => void onProposeWork(sourceEventId).catch(() => undefined)}
            onCommitWork={(work, participant) => void onCommitWork(work, participant).catch(() => undefined)}
            onDeclineWork={(work) => void onDeclineWork(work).catch(() => undefined)}
            onAcceptWorkResult={(work) => void onAcceptWorkResult(work).catch(() => undefined)}
            onRequestWorkRevision={onRequestWorkRevision}
            onCompleteWork={(work) => void onCompleteWork(work).catch(() => undefined)}
            onCreateVote={onCreateVote}
            onCastVote={(vote, optionId) => void onCastVote(vote, optionId).catch(() => undefined)}
            onCloseVote={(vote) => void onCloseVote(vote).catch(() => undefined)}
            roadmapActions={(work) => roadmapActionsFor(work, roadmaps, humanId, onCreateRoadmap, onSetRoadmapWorks)}
            reactions={channelReactions}
            onSetReaction={onSetReaction}
            highlightedId={highlightedId}
          />
        ))}
    </div>
  );
}
