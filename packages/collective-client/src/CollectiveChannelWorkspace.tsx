import type { CollectiveMaterialPublication } from '@cat-cafe/shared';
import type { Dispatch, SetStateAction } from 'react';
import type { ChannelContent } from './ChannelContentTabs.js';
import { ChannelScene } from './ChannelScene.js';
import type { CollectiveEventEnvelope, CollectiveWorkProjection } from './client-types.js';
import type { useFirstEntryGuide } from './first-entry/use-first-entry-guide.js';
import { MemberPanel, type MemberSelection } from './MemberPanel.js';
import { ProjectMaterialsProvider } from './ProjectMaterialsContext.js';
import type { RoadmapViewState } from './roadmap-view-model.js';
import type { useCollectiveClient } from './use-collective-client.js';
import type { useHostContext } from './use-host-context.js';
import { WorkTimeCommandContext } from './WorkTimeCommandContext.js';

export function CollectiveChannelWorkspace({
  channelId,
  client,
  content,
  firstEntry,
  focusEventId,
  host,
  namespace,
  onContent,
  onMember,
  onNavigation,
  onLibrary,
  onOpenRoadmapMessage,
  onOpenMaterialSource,
  onOpenTimeSource,
  onReplayGuide,
  onReturnToRoadmap,
  onRoadmapView,
  onSelectChannel,
  query,
  roadmapReturnLabel,
  roadmapView,
  selectedMember,
  setSelectedMember,
}: {
  readonly channelId: string;
  readonly client: ReturnType<typeof useCollectiveClient>;
  readonly content: ChannelContent;
  readonly firstEntry: ReturnType<typeof useFirstEntryGuide>;
  readonly focusEventId?: string;
  readonly host: ReturnType<typeof useHostContext>;
  readonly namespace: string;
  readonly onContent: (content: ChannelContent) => void;
  readonly onMember: (event: CollectiveEventEnvelope) => void;
  readonly onNavigation: () => void;
  readonly onLibrary?: (channelId: string) => void;
  readonly onOpenTimeSource?: (eventId: string, channelId: string) => void;
  readonly onOpenMaterialSource?: (publication: CollectiveMaterialPublication, view: RoadmapViewState) => void;
  readonly onOpenRoadmapMessage: (work: CollectiveWorkProjection, view: RoadmapViewState, eventId: string) => void;
  readonly onReplayGuide: () => void;
  readonly onReturnToRoadmap?: () => void;
  readonly onRoadmapView: (view: RoadmapViewState) => void;
  readonly onSelectChannel: (channelId: string, eventId?: string) => void;
  readonly query: string;
  readonly roadmapReturnLabel?: string;
  readonly roadmapView?: RoadmapViewState;
  readonly selectedMember?: MemberSelection | 'members';
  readonly setSelectedMember: Dispatch<SetStateAction<MemberSelection | 'members' | undefined>>;
}) {
  const { snapshot } = client;
  if (!snapshot.collective || !snapshot.me) return null;
  const participants = snapshot.participants ?? [];
  const members = snapshot.members;
  const showCafe = host.available ? () => host.show('cats') : undefined;
  const showChannelCafe = host.available ? () => host.show('channel') : undefined;

  return (
    <WorkTimeCommandContext.Provider value={{ change: client.changeWorkTime, openSource: onOpenTimeSource }}>
      <ProjectMaterialsProvider client={client.materialClient} onOpenSource={onOpenMaterialSource}>
        <ChannelScene
          key={channelId}
          collective={snapshot.collective}
          humanId={snapshot.me.human.humanId}
          humanName={snapshot.me.human.displayName}
          channelId={channelId}
          content={content}
          onSelectContent={onContent}
          onOpenLibrary={onLibrary}
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
          onCreateProject={client.createProject}
          onCreateProjectTask={client.createProjectTask}
          onRequestWorkAccountability={client.requestWorkAccountability}
          onRespondWorkAccountability={client.respondWorkAccountability}
          onDecideProjectSuggestion={client.decideProjectWorkSuggestion}
          onSetRoadmapWorks={client.setRoadmapWorks}
          onSetRoadmapStatus={client.setRoadmapStatus}
          roadmapView={roadmapView}
          onRoadmapViewChange={onRoadmapView}
          onOpenRoadmapSource={(work, view) => onOpenRoadmapMessage(work, view, work.sourceEventId)}
          onOpenRoadmapResult={(work, view) => {
            if (work.resultEventId) onOpenRoadmapMessage(work, view, work.resultEventId);
          }}
          roadmapReturnLabel={roadmapReturnLabel}
          onReturnToRoadmap={onReturnToRoadmap}
          onCreateVote={client.createVote}
          onCastVote={client.castVote}
          onCloseVote={client.closeVote}
          onCreateBindingVote={client.createBindingVote}
          onCastBindingVote={client.castBindingVote}
          onWithdrawBindingVote={client.withdrawBindingVote}
          onSettleBindingVote={client.settleBindingVote}
          onChangeWorkTime={client.changeWorkTime}
          onChangeProjectTarget={client.setProjectTargetDate}
          onSetWorkDependencies={client.setWorkDependencies}
          onSetReaction={client.setReaction}
          onOpenNavigation={onNavigation}
          onMembers={() => {
            host.hide();
            setSelectedMember('members');
          }}
          onSearch={() => {
            onNavigation();
            requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.destination-search input')?.focus());
          }}
          onOpenMember={onMember}
          onCafe={showCafe}
          onChannelCafe={showChannelCafe}
          hostActivity={host.available}
          onOpenTopic={() => {
            host.hide();
            setSelectedMember(undefined);
          }}
          onOpenChannel={onSelectChannel}
          contextFullPage={selectedMember === 'members' || host.open}
          context={
            host.open ? (
              <div className="context-panel" aria-hidden="true" />
            ) : (
              selectedMember && (
                <MemberPanel
                  member={selectedMember}
                  privateRoster={host.available}
                  members={members}
                  participants={participants}
                  events={snapshot.events}
                  onSelect={setSelectedMember}
                  onCafe={showCafe}
                  onReplayGuide={firstEntry.narrator ? onReplayGuide : undefined}
                  onClose={() => setSelectedMember(undefined)}
                />
              )
            )
          }
        />
      </ProjectMaterialsProvider>
    </WorkTimeCommandContext.Provider>
  );
}
