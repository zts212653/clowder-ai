import { useCallback, useEffect, useRef, useState } from 'react';
import { ChannelComposer } from './ChannelComposer.js';
import { ChannelConversationFlow } from './ChannelConversationFlow.js';
import { ChannelHeader } from './ChannelHeader.js';
import { ChannelRightPanel } from './ChannelRightPanel.js';
import { ChannelTopicContext } from './ChannelTopicContext.js';
import { CollectiveWorkCard } from './CollectiveWorkCard.js';
import type { MentionSelection } from './Composer.js';
import { collaborationForChannel } from './channel-collaboration.js';
import { actorDisplayName, groupChannelThreads } from './channel-model.js';
import { eventChannelId } from './channel-navigation.js';
import type { ChannelSceneProps } from './channel-scene-props.js';
import type { CollectiveEventEnvelope } from './client-types.js';
import { DemoPlayback } from './first-entry/DemoPlayback.js';
import { PublicChannelActivity } from './PublicChannelActivity.js';
import { mentionSelectionForEvent } from './participant-identity.js';
import { RoadmapWorkspace } from './RoadmapWorkspace.js';
import { SharedArtifactLibrary } from './SharedArtifactLibrary.js';
import { SharedArtifactSurface } from './SharedArtifactSurface.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function ChannelScene(props: ChannelSceneProps) {
  const {
    collective,
    humanId,
    humanName,
    channelId,
    content,
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
    onCreateProject,
    onCreateProjectTask,
    onRequestWorkAccountability,
    onRespondWorkAccountability,
    onDecideProjectSuggestion,
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
    onChannelCafe,
    members,
    firstEntry,
  } = props;
  const shared = useSharedArtifacts();
  const selectedArtifact = shared?.catalogue.find((item) => item.artifactId === shared.selected?.artifactId);
  const sharedOpenSource = useRef(onOpenTopic);
  sharedOpenSource.current = onOpenTopic;
  const [rightPanel, setRightPanel] = useState<'artifacts' | 'works'>();
  const [topicRootId, setTopicRootId] = useState<string>();
  const [sharedDiscussionOpen, setSharedDiscussionOpen] = useState(false);
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
  const artifactTopicId = selectedArtifact?.sourceLocation.rootEventId ?? selectedArtifact?.sourceEventId;
  useEffect(() => {
    if (!artifactTopicId) return;
    setTopicRootId(artifactTopicId);
    setReplyRequest(undefined);
    sharedOpenSource.current();
  }, [artifactTopicId]);
  const humans = members?.humans ?? [];
  const humanNames = Object.fromEntries(humans.map((human) => [human.humanId, human.displayName]));
  const {
    allWorks,
    channelWorks,
    channelVotes,
    roadmaps: channelRoadmaps,
    bindingVotes,
    decisions,
  } = collaborationForChannel(collaboration, channelId);
  const roadmaps = content === 'roadmap' ? (collaboration?.roadmaps ?? []) : channelRoadmaps;
  const channelReactions = (collaboration?.reactions ?? []).filter((reaction) =>
    threads.some((thread) => [thread.root, ...thread.replies].some((event) => event.eventId === reaction.eventId)),
  );
  const legacy = events.filter((event) => !eventChannelId(event));
  const openTopic = (id: string, focusComposer = false) => {
    setRightPanel(undefined);
    setTopicRootId(id);
    setReplyRequest(focusComposer ? { eventId: id } : undefined);
    onOpenTopic();
  };
  const returnToRoot = useCallback(
    (event: CollectiveEventEnvelope) => {
      shared?.close();
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
    [channelId, onOpenChannel, shared?.close],
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
    // While the work is open, its exact original Topic owns this pane; a channel focus cannot close it.
    if (shared?.selected) return;
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
  }, [events, focusEventId, shared?.selected]);
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
      data-context-open={Boolean(context || topic || rightPanel)}
      data-shared-artifact-open={Boolean(shared?.selected)}
      data-shared-discussion-open={Boolean(shared?.selected && sharedDiscussionOpen)}
      data-entry-browsing={firstEntry?.phase === 'browsing'}
    >
      <section
        className="channel-scene"
        hidden={Boolean(shared?.selected) || props.contextFullPage}
        aria-label={search ? '搜索结果' : `# ${channelId}`}
      >
        {content !== 'roadmap' && (
          <ChannelHeader
            collectiveName={collective.name}
            channelId={channelId}
            searchCount={search ? threads.length : undefined}
            connection={connection}
            onOpenNavigation={onOpenNavigation}
            onCafe={onCafe}
            onChannelCafe={onChannelCafe}
            memberCount={
              members
                ? members.humans.length +
                  participants.filter((p) => p.availability === 'declared' && p.channelIds.includes(channelId)).length
                : undefined
            }
            artifactCount={
              shared?.status === 'ready'
                ? shared.catalogue.filter((a) => a.sourceLocation.channelId === channelId).length
                : undefined
            }
            workCount={collaboration ? channelWorks.length : undefined}
            onMembers={props.onMembers}
            onArtifacts={
              shared?.api
                ? () => {
                    setTopicRootId(undefined);
                    onCloseContext?.();
                    setRightPanel((p) => (p === 'artifacts' ? undefined : 'artifacts'));
                  }
                : undefined
            }
            onWorks={() => {
              setTopicRootId(undefined);
              onCloseContext?.();
              setRightPanel((p) => (p === 'works' ? undefined : 'works'));
            }}
            onSearch={props.onSearch}
            activePanel={rightPanel}
            guideCatCount={
              firstEntry?.phase === 'playing' && firstEntry.beat === 0 && firstEntry.arrivalComplete
                ? firstEntry.ownCats.length
                : undefined
            }
          />
        )}
        {content === 'conversation' && roadmapReturnLabel && onReturnToRoadmap && (
          <button type="button" className="roadmap-return" onClick={onReturnToRoadmap}>
            ← 返回 {roadmapReturnLabel}
          </button>
        )}
        {content === 'artifacts' ? (
          <SharedArtifactLibrary key={namespace} channelId={channelId} filterable />
        ) : content === 'roadmap' ? (
          <RoadmapWorkspace
            roadmaps={roadmaps}
            works={allWorks}
            artifacts={shared?.catalogue}
            artifactStatus={shared?.status}
            currentHumanId={humanId}
            channelId={channelId}
            humans={humans}
            participants={participants}
            humanNames={humanNames}
            view={roadmapView}
            onViewChange={onRoadmapViewChange}
            onOpenNavigation={onOpenNavigation}
            onOpenSource={onOpenRoadmapSource}
            onOpenResult={onOpenRoadmapResult}
            onOpenArtifact={shared?.open}
            onSetDependencies={(work, dependencyWorkIds) =>
              void onSetWorkDependencies(work, dependencyWorkIds).catch(() => undefined)
            }
            onSetStatus={(roadmap, status) => void onSetRoadmapStatus(roadmap, status).catch(() => undefined)}
            onCreateProject={onCreateProject}
            onCreateProjectTask={onCreateProjectTask}
            onCommitWork={onCommitWork}
            onRequestWorkAccountability={onRequestWorkAccountability}
            onRespondWorkAccountability={onRespondWorkAccountability}
            onDecideProjectSuggestion={onDecideProjectSuggestion}
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
          <div className="channel-composer-placement">
            <PublicChannelActivity
              works={channelWorks}
              humanId={humanId}
              participants={participants}
              hostAvailable={Boolean(props.hostActivity)}
              requestedEventIds={
                new Set(
                  events
                    .filter((event) => event.actor.kind === 'human' && event.actor.humanId === humanId)
                    .map((event) => event.eventId),
                )
              }
              onOpen={openTopic}
            />
            {props.hostActivity && <div className="private-activity-slot" data-host-ui-slot="activity" />}
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
          </div>
        )}
      </section>
      {rightPanel && !context && !topic && (
        <ChannelRightPanel
          title={rightPanel === 'artifacts' ? '频道作品' : '频道任务'}
          onClose={() => setRightPanel(undefined)}
        >
          {rightPanel === 'artifacts' ? (
            <SharedArtifactLibrary
              key={namespace}
              channelId={channelId}
              presentation="channel"
              onOpenChannelLibrary={() => props.onOpenLibrary?.(channelId)}
            />
          ) : !collaboration ? (
            <p>正在读取任务…</p>
          ) : !channelWorks.length ? (
            <p>这个频道还没有任务。</p>
          ) : (
            channelWorks.map((work) => (
              <CollectiveWorkCard
                key={work.workId}
                work={work}
                works={allWorks}
                currentHumanId={humanId}
                humanNames={humanNames}
                participants={participants}
                canSteward={collective.role === 'steward'}
                sourceOwnerHumanId={(() => {
                  const actor = events.find((e) => e.eventId === work.sourceEventId)?.actor;
                  return actor?.kind === 'human' ? actor.humanId : (actor?.human.humanId ?? '');
                })()}
                onCommit={onCommitWork}
                onDecline={onDeclineWork}
                onAcceptResult={onAcceptWorkResult}
                onRequestRevision={onRequestWorkRevision}
                onComplete={onCompleteWork}
              />
            ))
          )}
        </ChannelRightPanel>
      )}
      {context ||
        (topic && (
          <ChannelTopicContext
            key={topic.root.eventId}
            scene={props}
            topic={topic}
            replyRequest={replyRequest}
            works={channelWorks}
            votes={channelVotes}
            humanNames={humanNames}
            roadmaps={roadmaps}
            reactions={channelReactions}
            highlightedId={highlightedId}
            onClose={() => (shared?.selected ? setSharedDiscussionOpen(false) : returnToRoot(topic.root))}
            onReturnToSource={() => returnToRoot(topic.root)}
          />
        ))}
      {shared?.selected && (
        <SharedArtifactSurface
          onOpenDiscussion={() => setSharedDiscussionOpen(true)}
          onReturnToSource={(sourceChannelId, eventId) => onOpenChannel?.(sourceChannelId, eventId)}
        />
      )}
    </div>
  );
}
