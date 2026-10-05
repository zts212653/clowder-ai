import { useEffect, useState } from 'react';
import type { ChannelContent } from './ChannelContentTabs.js';
import { ChannelNavigation } from './ChannelNavigation.js';
import { ChannelScene } from './ChannelScene.js';
import { channelDestinations, readChannelPosition, saveChannelPosition } from './channel-navigation.js';
import type { CollectiveEventEnvelope, CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { DemoSpotlight } from './first-entry/DemoSpotlight.js';
import { EntrySpotlight } from './first-entry/EntrySpotlight.js';
import { useFirstEntryGuide } from './first-entry/use-first-entry-guide.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import { MemberPanel, type MemberSelection } from './MemberPanel.js';
import { ProductShell } from './ProductShell.js';
import type { RoadmapViewState } from './roadmap-view-model.js';
import type { useCollectiveClient } from './use-collective-client.js';
import { useHostContext } from './use-host-context.js';
import { HostWorkPermissionContext } from './use-host-work-policy.js';

function ownDeclaredCatCount(
  participants: readonly CollectiveParticipant[] | undefined,
  connectionId: string | undefined,
) {
  if (!participants || !connectionId) return undefined;
  return new Set(
    participants
      .filter((cat) => cat.connectionId === connectionId && cat.availability === 'declared')
      .map((cat) => cat.catId),
  ).size;
}

export function CollectiveWorkspace({
  embedded,
  client,
}: {
  readonly embedded: boolean;
  readonly client: ReturnType<typeof useCollectiveClient>;
}) {
  const { snapshot } = client;
  const namespace = collectiveClientNamespace(snapshot) ?? '';
  const [channelId, setChannelId] = useState(() => readChannelPosition(namespace));
  const [focusEventId, setFocusEventId] = useState<string>();
  const [content, setContent] = useState<ChannelContent>('conversation');
  const [roadmapViews, setRoadmapViews] = useState<Readonly<Record<string, RoadmapViewState>>>({});
  const [roadmapReturn, setRoadmapReturn] = useState<RoadmapReturn>();
  const [query, setQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberSelection | 'members'>();
  const participants = snapshot.participants ?? [];
  const channels = channelDestinations(snapshot.events, participants);
  const host = useHostContext(
    embedded,
    snapshot,
    channelId,
    channels.map((channel) => channel.id),
    client.hostHumanSession,
  );
  const firstEntry = useFirstEntryGuide({
    embedded,
    ready: Boolean(snapshot.me?.auth && snapshot.collective && snapshot.meta),
    serviceInstanceId: snapshot.meta?.serviceInstanceId,
    collectiveId: snapshot.collective?.collectiveId,
    humanId: snapshot.me?.human.humanId,
    paired: host.paired,
    connectionId: host.connectionId,
    publishedCatCount: host.participationReady?.catCount,
    participants: snapshot.participants,
    events: snapshot.events,
  });
  useEffect(() => {
    if (firstEntry.phase !== 'playing') return;
    setChannelId('general');
    setContent('conversation');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
  }, [firstEntry.phase, host.hide]);
  useEffect(() => {
    if (!host.focusWork) return;
    setFocusEventId(host.focusWork.eventId);
    setContent('conversation');
    setRoadmapReturn(undefined);
    setChannelId(host.focusWork.channelId);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
  }, [host.focusWork]);
  const showCafe = () => {
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.show();
  };
  const replayGuide = () => {
    setSelectedMember(undefined);
    setNavigationOpen(false);
    firstEntry.replay();
  };
  const beginPair = () => {
    firstEntry.beginPair();
    setNavigationOpen(false);
    void client.pairHost();
  };
  const selectChannel = (id: string, eventId?: string) => {
    setFocusEventId(eventId);
    setContent('conversation');
    setRoadmapReturn(undefined);
    host.hide();
    setChannelId(id);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
  };
  useEffect(() => saveChannelPosition(namespace, channelId), [namespace, channelId]);
  useEffect(() => {
    setContent('conversation');
    setRoadmapReturn(undefined);
    setRoadmapViews({});
  }, [namespace]);
  if (!snapshot.collective || !snapshot.me) return null;
  const openMember = (event: CollectiveEventEnvelope) => {
    host.hide();
    setSelectedMember(
      event.actor.kind === 'human'
        ? { kind: 'human', humanId: event.actor.humanId }
        : { kind: 'agent', connectionId: event.actor.provenance.connectionId, catId: event.actor.provenance.catId },
    );
  };
  const members = snapshot.members;
  const visibleCats = participants.filter(
    (cat) => cat.availability === 'declared' && members?.cafes.some((cafe) => cafe.connectionId === cat.connectionId),
  );
  const ownCatCount = ownDeclaredCatCount(snapshot.participants, host.connectionId);
  const roadmapView = roadmapViews[channelId];
  const updateRoadmapView = (view: RoadmapViewState) =>
    setRoadmapViews((current) => ({ ...current, [channelId]: view }));
  const openRoadmapMessage = (work: CollectiveWorkProjection, view: RoadmapViewState, eventId: string) => {
    const roadmap = snapshot.collaboration?.roadmaps.find((candidate) => candidate.roadmapId === view.roadmapId);
    setRoadmapViews((current) => ({ ...current, [channelId]: view }));
    setRoadmapReturn({ channelId, label: roadmap?.title ?? 'Roadmap', view });
    setFocusEventId(eventId);
    setContent('conversation');
    host.hide();
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setQuery('');
    setChannelId(work.sourceLocation.channelId);
  };
  const returnToRoadmap = () => {
    if (!roadmapReturn) return;
    setRoadmapViews((current) => ({ ...current, [roadmapReturn.channelId]: roadmapReturn.view }));
    setFocusEventId(undefined);
    setChannelId(roadmapReturn.channelId);
    setContent('roadmap');
    setRoadmapReturn(undefined);
    host.hide();
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setQuery('');
  };

  return (
    <HostWorkPermissionContext.Provider
      value={{ connectionId: host.connectionId, request: host.requestWorkPermission }}
    >
      <ProductShell
        embedded={embedded}
        collective={snapshot.collective}
        collectives={snapshot.me.collectives}
        onSelectCollective={client.selectCollective}
        connection={snapshot.connection}
        canSteward={snapshot.collective.role === 'steward'}
        canPair={Boolean(snapshot.me.auth) && !host.paired}
        cafeConnection={
          host.paired
            ? { catCount: firstEntry.phase === 'loading' && firstEntry.pairStarted ? undefined : ownCatCount }
            : undefined
        }
        pairNudge={firstEntry.phase === 'browsing'}
        canLeave={snapshot.collective.role === 'member'}
        headerMeta={
          members
            ? `${members.cafes.length} 个 Café · ${members.humans.length + visibleCats.length} 位成员`
            : '正在读取成员…'
        }
        notice={snapshot.notice}
        onInvite={() => void client.createInvite()}
        onPair={beginPair}
        onLeave={() => void client.leaveCollective()}
        navigationOpen={navigationOpen || firstEntry.phase === 'entry'}
        onCloseNavigation={() => setNavigationOpen(false)}
        destinations={
          <ChannelNavigation
            channels={channels}
            channelId={channelId}
            query={query}
            onQuery={setQuery}
            onSelect={selectChannel}
            onCafe={host.available ? showCafe : undefined}
            onReplayGuide={firstEntry.narrator ? replayGuide : undefined}
            guideCatCount={
              firstEntry.phase === 'playing' && firstEntry.beat === 0
                ? firstEntry.arrivalComplete
                  ? firstEntry.ownCats.length
                  : 0
                : undefined
            }
            onMembers={() => {
              host.hide();
              setSelectedMember('members');
              setNavigationOpen(false);
            }}
          />
        }
      >
        <ChannelScene
          key={channelId}
          collective={snapshot.collective}
          humanId={snapshot.me.human.humanId}
          humanName={snapshot.me.human.displayName}
          channelId={channelId}
          content={content}
          onSelectContent={(next) => {
            setContent(next);
            if (next === 'roadmap') setRoadmapReturn(undefined);
          }}
          focusEventId={focusEventId}
          onCloseContext={() => {
            host.hide();
            setSelectedMember(undefined);
          }}
          namespace={namespace}
          query={query}
          events={snapshot.events}
          collaboration={snapshot.collaboration}
          participants={participants}
          members={members}
          firstEntry={firstEntry}
          error={snapshot.error}
          connection={snapshot.connection}
          delivery={snapshot.delivery}
          onSend={client.sendMessage}
          onProposeWork={client.proposeWork}
          onCommitWork={client.commitWork}
          onDeclineWork={client.declineWork}
          onAcceptWorkResult={client.acceptWorkResult}
          onRequestWorkRevision={client.requestWorkRevision}
          onCompleteWork={client.completeWork}
          onCreateRoadmap={client.createRoadmap}
          onSetRoadmapWorks={client.setRoadmapWorks}
          onSetRoadmapStatus={client.setRoadmapStatus}
          roadmapView={roadmapView}
          onRoadmapViewChange={updateRoadmapView}
          onOpenRoadmapSource={(work, view) => openRoadmapMessage(work, view, work.sourceEventId)}
          onOpenRoadmapResult={(work, view) => {
            if (work.resultEventId) openRoadmapMessage(work, view, work.resultEventId);
          }}
          roadmapReturnLabel={roadmapReturn?.label}
          onReturnToRoadmap={roadmapReturn ? returnToRoadmap : undefined}
          onCreateVote={client.createVote}
          onCastVote={client.castVote}
          onCloseVote={client.closeVote}
          onCreateBindingVote={client.createBindingVote}
          onCastBindingVote={client.castBindingVote}
          onWithdrawBindingVote={client.withdrawBindingVote}
          onSettleBindingVote={client.settleBindingVote}
          onSetWorkDependencies={client.setWorkDependencies}
          onSetReaction={client.setReaction}
          onOpenNavigation={() => setNavigationOpen((value) => !value)}
          onOpenMember={openMember}
          onCafe={host.available ? showCafe : undefined}
          onOpenTopic={() => {
            host.hide();
            setSelectedMember(undefined);
          }}
          onOpenChannel={selectChannel}
          context={
            host.open ? (
              <div className="context-panel" aria-hidden="true" />
            ) : (
              selectedMember && (
                <MemberPanel
                  member={selectedMember}
                  members={members}
                  participants={participants}
                  events={snapshot.events}
                  onSelect={setSelectedMember}
                  onCafe={host.available ? showCafe : undefined}
                  onReplayGuide={firstEntry.narrator ? replayGuide : undefined}
                  onClose={() => setSelectedMember(undefined)}
                />
              )
            )
          }
        />
      </ProductShell>
      {firstEntry.phase === 'entry' && <EntrySpotlight onPair={beginPair} onBrowse={firstEntry.browse} />}
      {firstEntry.phase === 'playing' && channelId === 'general' && (
        <DemoSpotlight
          beat={firstEntry.beat}
          selectedCats={firstEntry.ownCats}
          arrivalComplete={firstEntry.arrivalComplete}
          onNext={firstEntry.next}
          onSkip={firstEntry.finish}
        />
      )}
      {firstEntry.phase === 'handoff' && firstEntry.handoffCaptionVisible && firstEntry.narrator && (
        <section className="demo-caption demo-handoff-caption" data-handoff-caption aria-label="轮到你">
          <h2>换你来</h2>
          <p>点名 {firstEntry.narrator.displayName} 试试</p>
        </section>
      )}
    </HostWorkPermissionContext.Provider>
  );
}

interface RoadmapReturn {
  readonly channelId: string;
  readonly label: string;
  readonly view: RoadmapViewState;
}
