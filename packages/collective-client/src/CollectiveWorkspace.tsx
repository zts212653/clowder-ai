import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelContent } from './ChannelContentTabs.js';
import { ChannelNavigation } from './ChannelNavigation.js';
import { CollectiveChannelWorkspace } from './CollectiveChannelWorkspace.js';
import { CollectiveHome } from './CollectiveHome.js';
import {
  channelDestinations,
  clearChannelPosition,
  readChannelEntry,
  saveChannelPosition,
  writeChannelTarget,
  writeLibraryTarget,
} from './channel-navigation.js';
import type { CollectiveEventEnvelope, CollectiveWorkProjection } from './client-types.js';
import type { SharedArtifactOpenOptions } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { type RoadmapReturn, visibleCollectiveCats } from './collective-workspace-model.js';
import { FirstEntryOverlays } from './first-entry/FirstEntryOverlays.js';
import { useFirstEntryGuide } from './first-entry/use-first-entry-guide.js';
import { HostedDocumentSelection } from './HostedDocumentSelection.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import { LeaveCollectiveDialog } from './LeaveCollectiveDialog.js';
import type { LeaveReadinessArtifact, LeaveReadinessProject, LeaveReadinessWork } from './leave-readiness.js';
import type { MemberSelection } from './MemberPanel.js';
import { ProductShell } from './ProductShell.js';
import { defaultRoadmapView, type RoadmapViewState } from './roadmap-view-model.js';
import { SharedArtifactLibrary } from './SharedArtifactLibrary.js';
import { SharedArtifactPublication } from './SharedArtifactPublication.js';
import { SharedArtifactReading } from './SharedArtifactReading.js';
import { CollectiveArtifactContext } from './use-collective-artifacts.js';
import type { useCollectiveClient } from './use-collective-client.js';
import { useHostContext } from './use-host-context.js';
import { HostWorkPermissionContext } from './use-host-work-policy.js';
import { useSharedArtifactNavigation } from './use-shared-artifact-navigation.js';

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This coordinator is the sole owner of destination, Host, guide, and roadmap transitions, including exact artifact returns. Scenes, guide overlays, and artifact return-point handling are separate; splitting these coupled transitions would duplicate navigation state.
export function CollectiveWorkspace({
  embedded,
  client,
}: {
  readonly embedded: boolean;
  readonly client: ReturnType<typeof useCollectiveClient>;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const { snapshot } = client;
  const namespace = collectiveClientNamespace(snapshot) ?? '';
  const previousNamespace = useRef(namespace);
  const initialEntry = readChannelEntry(namespace);
  const [channelId, setChannelId] = useState(initialEntry.channelId);
  const [destination, setDestination] = useState<'home' | 'channel' | 'library'>(initialEntry.destination);
  const [focusEventId, setFocusEventId] = useState<string>();
  const [content, setContent] = useState<ChannelContent>('conversation');
  const [roadmapViews, setRoadmapViews] = useState<Readonly<Record<string, RoadmapViewState>>>({});
  const [roadmapReturn, setRoadmapReturn] = useState<RoadmapReturn>();
  const [query, setQuery] = useState('');
  const [libraryChannel, setLibraryChannel] = useState<{ channelId: string; revision: number }>();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberSelection | 'members'>();
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const participants = snapshot.participants ?? [];
  const channels = channelDestinations(snapshot.events, participants);
  const mediaArtifact = client.artifacts?.catalogue.find(
    (item) => item.artifactId === client.artifacts?.selected?.artifactId,
  );
  const restoreArtifactProject = (target: NonNullable<SharedArtifactOpenOptions['projectReturn']>) => {
    setDestination('channel');
    setChannelId(target.channelId);
    setContent('roadmap');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setFocusEventId(undefined);
    setRoadmapViews((current) => ({
      ...current,
      [target.channelId]: {
        ...defaultRoadmapView,
        roadmapId: target.roadmapId,
        lens: 'artifacts',
        workspace: 'project',
      },
    }));
    writeChannelTarget(target.channelId);
  };
  const host = useHostContext(
    embedded,
    snapshot,
    channelId,
    channels.map((channel) => channel.id),
    client.hostHumanSession,
    {
      api: client.artifacts?.api,
      humanName: client.artifacts?.humanName,
      onShared: async (artifact) => {
        await client.artifacts?.refresh();
        client.artifacts?.closePublication();
        client.artifacts?.open(artifact);
      },
      onDocumentReturn: (target, targetDestination) => {
        if (targetDestination === 'project' && target.projectReturn) {
          artifactNavigation.discard();
          restoreArtifactProject(target.projectReturn);
        } else if (targetDestination === 'discussion') {
          const artifact = client.artifacts?.catalogue.find((item) => item.artifactId === target.artifactId);
          if (artifact)
            client.artifacts?.open(artifact, target.ownerRevision, {
              projectReturn: target.projectReturn,
              discussionOnly: true,
            });
          setDestination('channel');
          setChannelId(target.channelId);
          setContent('conversation');
          requestAnimationFrame(() => window.dispatchEvent(new Event('collective:reveal-document-discussion')));
        } else selectChannel(target.channelId, target.sourceEventId);
      },
      selection: mediaArtifact && {
        artifact: mediaArtifact,
        ownerRevision: client.artifacts?.selected?.ownerRevision,
        options: client.artifacts?.selected?.options,
        onReturn: () => {
          artifactNavigation.close();
        },
      },
    },
    () => showMembers(),
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
  const previousFirstEntryPhase = useRef<typeof firstEntry.phase>();
  const artifactNavigation = useSharedArtifactNavigation({
    namespace,
    artifacts: client.artifacts,
    place: { destination, channelId, content, query, focusEventId, roadmapReturn },
    onOpenSource: (id, eventId) => selectChannel(id, eventId),
    onRestoreProject: restoreArtifactProject,
    onRestore: (place) => {
      setDestination(place.destination);
      setChannelId(place.channelId);
      setContent(place.content);
      setQuery(place.query);
      setFocusEventId(place.focusEventId);
      setRoadmapReturn(place.roadmapReturn);
      setSelectedMember(undefined);
      setNavigationOpen(false);
      host.hide();
      if (place.destination === 'library') writeLibraryTarget();
      else writeChannelTarget(place.destination === 'channel' ? place.channelId : undefined);
    },
  });
  const enterFirstEntryChannel = useCallback(() => {
    setDestination('channel');
    setChannelId('general');
    writeChannelTarget('general');
    setContent('conversation');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
  }, [host.hide]);
  useEffect(() => {
    const guideStarted = firstEntry.phase === 'playing' && previousFirstEntryPhase.current !== 'playing';
    previousFirstEntryPhase.current = firstEntry.phase;
    if (guideStarted && destination === 'home') enterFirstEntryChannel();
  }, [destination, enterFirstEntryChannel, firstEntry.phase]);
  useEffect(() => {
    const focus = host.focusWork;
    if (!focus) return;
    if ('roadmapId' in focus) {
      setDestination('channel');
      setFocusEventId(undefined);
      setContent('roadmap');
      setRoadmapReturn(undefined);
      setChannelId(focus.channelId);
      setRoadmapViews((current) => ({
        ...current,
        [focus.channelId]: {
          ...defaultRoadmapView,
          workspace: 'project',
          lens: 'attention' in focus && focus.attention === 'triage' ? 'triage' : 'stage',
          roadmapId: focus.roadmapId,
          workId: focus.workId,
        },
      }));
      writeChannelTarget(focus.channelId);
      setQuery('');
      setSelectedMember(undefined);
      setNavigationOpen(false);
      return;
    }
    setDestination('channel');
    setFocusEventId(focus.eventId);
    setContent('conversation');
    setRoadmapReturn(undefined);
    setChannelId(focus.channelId);
    writeChannelTarget(focus.channelId);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
  }, [host.focusWork]);
  const showMembers = () => {
    artifactNavigation.discard();
    setDestination('channel');
    writeChannelTarget(channelId);
    setSelectedMember('members');
    setNavigationOpen(false);
    host.hide();
  };
  const showPrivateSection = (section: 'permissions' | 'calendar' | 'connection') => {
    setNavigationOpen(false);
    host.show(section);
  };
  const replayGuide = () => {
    enterFirstEntryChannel();
    firstEntry.replay();
  };
  const beginPair = () => {
    enterFirstEntryChannel();
    firstEntry.beginPair();
    void client.pairHost();
  };
  const selectChannel = (id: string, eventId?: string) => {
    artifactNavigation.discard();
    setDestination('channel');
    setFocusEventId(eventId);
    setContent('conversation');
    setRoadmapReturn(undefined);
    host.hide();
    setChannelId(id);
    writeChannelTarget(id);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
  };
  const showHome = () => {
    artifactNavigation.discard();
    setDestination('home');
    setFocusEventId(undefined);
    setContent('conversation');
    setRoadmapReturn(undefined);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
    writeChannelTarget();
  };
  const showLibrary = (sourceChannel?: string) => {
    artifactNavigation.discard();
    if (sourceChannel)
      setLibraryChannel((current) => ({ channelId: sourceChannel, revision: (current?.revision ?? 0) + 1 }));
    setDestination('library');
    setNavigationOpen(false);
    setSelectedMember(undefined);
    host.hide();
    writeLibraryTarget();
  };
  useEffect(() => {
    if (previousNamespace.current !== namespace) return;
    if (destination === 'channel') saveChannelPosition(namespace, channelId);
    else if (destination === 'home') clearChannelPosition(namespace);
  }, [namespace, channelId, destination]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A world namespace change is the reset signal; Host callbacks must not replay this reset.
  useEffect(() => {
    const worldChanged = previousNamespace.current !== namespace;
    previousNamespace.current = namespace;
    setContent('conversation');
    setRoadmapReturn(undefined);
    setRoadmapViews({});
    if (!worldChanged) return;
    const nextEntry = readChannelEntry(namespace);
    setDestination(nextEntry.destination);
    setChannelId(nextEntry.channelId);
    setFocusEventId(undefined);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setLeaveDialogOpen(false);
    host.hide();
  }, [namespace]);
  if (!snapshot.collective || !snapshot.me) return null;
  const openMember = (event: CollectiveEventEnvelope) => {
    artifactNavigation.discard();
    host.hide();
    setSelectedMember(
      event.actor.kind === 'human'
        ? { kind: 'human', humanId: event.actor.humanId }
        : { kind: 'agent', connectionId: event.actor.provenance.connectionId, catId: event.actor.provenance.catId },
    );
  };
  const members = snapshot.members;
  const currentHumanId = snapshot.me.human.humanId;
  const visibleCats = visibleCollectiveCats(participants, members);
  const ownCats = snapshot.participants?.filter(
    (participant) => participant.availability === 'declared' && participant.humanId === currentHumanId,
  );
  const showCurrentHuman = () => {
    artifactNavigation.discard();
    setDestination('channel');
    writeChannelTarget(channelId);
    setSelectedMember({ kind: 'human', humanId: currentHumanId });
    setNavigationOpen(false);
    host.hide();
  };
  const roadmapView = roadmapViews[channelId];
  const updateRoadmapView = (view: RoadmapViewState) =>
    setRoadmapViews((current) => ({ ...current, [channelId]: view }));
  const openProjectSource = (sourceChannelId: string, view: RoadmapViewState, eventId: string) => {
    artifactNavigation.discard();
    const roadmap = snapshot.collaboration?.roadmaps.find((candidate) => candidate.roadmapId === view.roadmapId);
    setRoadmapViews((current) => ({ ...current, [channelId]: view }));
    setRoadmapReturn({ channelId, label: roadmap?.title ?? t('项目'), view });
    setFocusEventId(eventId);
    setDestination('channel');
    setContent('conversation');
    host.hide();
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setQuery('');
    setChannelId(sourceChannelId);
    writeChannelTarget(sourceChannelId);
  };
  const openRoadmapMessage = (work: CollectiveWorkProjection, view: RoadmapViewState, eventId: string) =>
    openProjectSource(work.sourceLocation.channelId, view, eventId);
  const returnToRoadmap = () => {
    if (!roadmapReturn) return;
    setRoadmapViews((current) => ({ ...current, [roadmapReturn.channelId]: roadmapReturn.view }));
    setFocusEventId(undefined);
    setDestination('channel');
    setChannelId(roadmapReturn.channelId);
    writeChannelTarget(roadmapReturn.channelId);
    setContent('roadmap');
    setRoadmapReturn(undefined);
    host.hide();
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setQuery('');
  };
  const openReadinessProject = (project: LeaveReadinessProject, workId?: string) => {
    const currentProject = snapshot.collaboration?.roadmaps.find(
      (candidate) => candidate.roadmapId === project.roadmapId,
    );
    if (!currentProject || (workId && !currentProject.workIds.includes(workId))) {
      selectChannel(project.source.location.channelId, project.source.eventId);
      return;
    }
    artifactNavigation.discard();
    setDestination('channel');
    setChannelId(project.source.location.channelId);
    setFocusEventId(undefined);
    setContent('roadmap');
    setRoadmapReturn(undefined);
    setRoadmapViews((current) => ({
      ...current,
      [project.source.location.channelId]: {
        ...defaultRoadmapView,
        workspace: 'project',
        roadmapId: project.roadmapId,
        ...(workId ? { workId } : {}),
      },
    }));
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
    writeChannelTarget(project.source.location.channelId);
  };
  const openReadinessWork = (work: LeaveReadinessWork) => {
    const project = work.projects.length === 1 ? work.projects[0] : undefined;
    const currentWork = snapshot.collaboration?.works.find((candidate) => candidate.workId === work.workId);
    if (project && currentWork) {
      openReadinessProject(project, work.workId);
      return;
    }
    selectChannel(work.source.location.channelId, work.source.eventId);
  };
  const openReadinessArtifact = (item: Extract<LeaveReadinessArtifact, { kind: 'artifact' }>) => {
    const current = client.artifacts?.catalogue.find((candidate) => candidate.artifactId === item.artifactId);
    if (current) {
      artifactNavigation.open(current, item.ownerRevision);
      return;
    }
    selectChannel(item.source.location.channelId, item.source.eventId);
  };

  return (
    <CollectiveArtifactContext.Provider
      value={
        client.artifacts && {
          ...client.artifacts,
          open: artifactNavigation.open,
          documentHosted: host.documentSurfaceReady,
          close: artifactNavigation.close,
          openWorkResultFile: async (address) => {
            const artifact = await client.artifacts?.resolveWorkResultFile(address);
            if (artifact) artifactNavigation.open(artifact);
          },
          returnLabel: artifactNavigation.returnLabel,
          returnToSource: selectChannel,
        }
      }
    >
      <SharedArtifactReading>
        <HostedDocumentSelection />
        <HostWorkPermissionContext.Provider
          value={{ connectionId: host.connectionId, request: host.requestWorkPermission }}
        >
          <ProductShell
            embedded={embedded}
            collective={snapshot.collective}
            collectives={snapshot.me.collectives}
            onSelectCollective={client.selectCollective}
            onHome={showHome}
            connection={snapshot.connection}
            canSteward={snapshot.collective.role === 'steward'}
            canPair={Boolean(snapshot.me.auth) && !host.paired}
            pairNudge={firstEntry.phase === 'browsing'}
            headerMeta={
              members
                ? language === 'en'
                  ? `${members.cafes.length} ${members.cafes.length === 1 ? 'Café' : 'Cafés'} · ${members.humans.length + visibleCats.length} ${members.humans.length + visibleCats.length === 1 ? 'member' : 'members'}`
                  : `${members.cafes.length} 个 Café · ${members.humans.length + visibleCats.length} 位成员`
                : t('正在读取成员…')
            }
            identity={{ human: snapshot.me.human, auth: snapshot.me.auth, cats: ownCats }}
            onOpenSelf={showCurrentHuman}
            onSwitchAccount={client.switchAccount}
            notice={snapshot.notice}
            onInvite={() => void client.createInvite()}
            onPair={beginPair}
            onLeave={() => {
              setNavigationOpen(false);
              setLeaveDialogOpen(true);
            }}
            onCafe={host.available ? showMembers : undefined}
            onPermissions={host.available ? () => showPrivateSection('permissions') : undefined}
            onCalendar={host.available ? () => showPrivateSection('calendar') : undefined}
            onReconnect={host.available ? () => showPrivateSection('connection') : undefined}
            onReplayGuide={firstEntry.narrator ? replayGuide : undefined}
            navigationOpen={navigationOpen || firstEntry.phase === 'entry'}
            onCloseNavigation={() => setNavigationOpen(false)}
            destinations={
              <ChannelNavigation
                channels={channels}
                channelId={destination === 'channel' ? channelId : undefined}
                query={query}
                onQuery={(value) => {
                  setQuery(value);
                  if (!value.trim()) return;
                  setDestination('channel');
                  writeChannelTarget(channelId);
                }}
                onSelect={selectChannel}
                libraryActive={destination === 'library'}
                onLibrary={client.artifacts?.api ? () => showLibrary() : undefined}
                roadmapActive={content === 'roadmap'}
                roadmapCount={snapshot.collaboration?.roadmaps.length}
                memberCount={members ? members.humans.length + visibleCats.length : undefined}
                onRoadmap={() => {
                  artifactNavigation.discard();
                  setDestination('channel');
                  setContent('roadmap');
                  setSelectedMember(undefined);
                  setNavigationOpen(false);
                  host.hide();
                  setQuery('');
                }}
                guideCatCount={
                  firstEntry.phase === 'playing' && firstEntry.beat === 0
                    ? firstEntry.arrivalComplete
                      ? firstEntry.ownCats.length
                      : 0
                    : undefined
                }
                onMembers={showMembers}
              />
            }
          >
            <SharedArtifactLibrary
              key={namespace}
              title={t('全部作品')}
              active={destination === 'library'}
              filterable
              requestedChannel={libraryChannel}
              onOpenNavigation={() => setNavigationOpen((value) => !value)}
            />
            {destination === 'home' ? (
              <CollectiveHome
                collective={snapshot.collective}
                events={snapshot.events}
                collaboration={snapshot.collaboration}
                connection={snapshot.connection}
                error={snapshot.error}
                onOpenNavigation={() => setNavigationOpen((value) => !value)}
                onOpenEvent={selectChannel}
              />
            ) : destination === 'channel' ? (
              <CollectiveChannelWorkspace
                channelId={channelId}
                client={client}
                content={content}
                firstEntry={firstEntry}
                focusEventId={focusEventId}
                host={host}
                namespace={namespace}
                onContent={(next) => {
                  setContent(next);
                  if (next === 'roadmap') setRoadmapReturn(undefined);
                }}
                onMember={openMember}
                onNavigation={() => setNavigationOpen((value) => !value)}
                onLibrary={showLibrary}
                onOpenRoadmapMessage={openRoadmapMessage}
                onOpenTimeSource={(eventId, sourceChannelId) =>
                  content === 'roadmap'
                    ? openProjectSource(sourceChannelId, roadmapView ?? defaultRoadmapView, eventId)
                    : selectChannel(sourceChannelId, eventId)
                }
                onOpenMaterialSource={(publication, view) =>
                  openProjectSource(publication.channelId, view, publication.sourceEventId)
                }
                onReplayGuide={replayGuide}
                onReturnToRoadmap={roadmapReturn ? returnToRoadmap : undefined}
                onRoadmapView={updateRoadmapView}
                onSelectChannel={selectChannel}
                query={query}
                roadmapReturnLabel={roadmapReturn?.label}
                roadmapView={roadmapView}
                selectedMember={selectedMember}
                setSelectedMember={setSelectedMember}
              />
            ) : null}
          </ProductShell>
          {leaveDialogOpen && (
            <LeaveCollectiveDialog
              collectiveName={snapshot.collective.name}
              read={client.readLeaveReadiness}
              leave={client.leaveCollective}
              onClose={() => setLeaveDialogOpen(false)}
              onOpenWork={openReadinessWork}
              onOpenProject={openReadinessProject}
              onOpenArtifact={openReadinessArtifact}
              onOpenMembers={showMembers}
            />
          )}
          <FirstEntryOverlays
            firstEntry={firstEntry}
            destination={destination}
            channelId={channelId}
            onPair={beginPair}
          />
        </HostWorkPermissionContext.Provider>
        {client.artifacts?.publicationSource && (
          <SharedArtifactPublication snapshot={snapshot} onPair={beginPair} onShareMedia={host.shareMedia} />
        )}
      </SharedArtifactReading>
    </CollectiveArtifactContext.Provider>
  );
}
