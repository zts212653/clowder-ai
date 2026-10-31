import type { ReactNode } from 'react';
import type { ChannelContent } from './ChannelContentTabs.js';
import type {
  ClientTarget,
  CollectiveBindingVoteChoice,
  CollectiveBindingVoteProjection,
  CollectiveChannelProjection,
  CollectiveCollaborationProjection,
  CollectiveEventEnvelope,
  CollectiveMemberDirectory,
  CollectiveMembership,
  CollectiveParticipant,
  CollectiveReactionEmoji,
  CollectiveRoadmapRecord,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
  DeliveryState,
} from './client-types.js';
import type { FirstEntryGuide } from './first-entry/use-first-entry-guide.js';
import type { ProjectSuggestionDecisionHandler } from './ProjectSuggestionActions.js';
import type { ProjectTargetChangeHandler } from './ProjectTimeSummary.js';
import type { RoadmapViewState } from './roadmap-view-model.js';
import type { ProjectTaskResponsibility } from './use-collective-collaboration.js';
import type { InformalVoteDraft } from './VoteCard.js';
import type { VoteDraft } from './VoteDraftForm.js';
import type { WorkTimeChangeHandler } from './WorkTimeEditor.js';

export interface ChannelSceneProps {
  readonly collective: CollectiveMembership;
  readonly humanId: string;
  readonly humanName: string;
  readonly channelId: string;
  readonly channel?: CollectiveChannelProjection;
  readonly content: ChannelContent;
  readonly onSelectContent: (content: ChannelContent) => void;
  readonly focusEventId?: string;
  readonly onCloseContext?: () => void;
  readonly namespace: string;
  readonly query: string;
  readonly events: readonly CollectiveEventEnvelope[];
  readonly collaboration?: CollectiveCollaborationProjection;
  readonly participants?: readonly CollectiveParticipant[];
  readonly connection: 'online' | 'offline';
  readonly delivery: DeliveryState;
  readonly error?: string;
  readonly onSend: (body: string, destination: ClientTarget) => Promise<void>;
  readonly onProposeWork: (sourceEventId: string) => Promise<void>;
  readonly onCommitWork: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => Promise<void>;
  readonly onDeclineWork: (work: CollectiveWorkProjection) => Promise<void>;
  readonly onAcceptWorkResult: (work: CollectiveWorkProjection) => Promise<void>;
  readonly onRequestWorkRevision: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly onCompleteWork: (work: CollectiveWorkProjection) => Promise<void>;
  readonly onCreateRoadmap: (work: CollectiveWorkProjection) => Promise<void>;
  readonly onCreateProject?: (channelId: string, title: string, purpose: string) => Promise<void>;
  readonly onCreateProjectTask?: (
    roadmap: CollectiveRoadmapRecord,
    channelId: string,
    title: string,
    intendedOutcome: string,
    responsibility: ProjectTaskResponsibility,
  ) => Promise<void>;
  readonly onRequestWorkAccountability?: (
    roadmap: CollectiveRoadmapRecord,
    work: CollectiveWorkProjection,
    targetHumanId: string,
  ) => Promise<void>;
  readonly onRespondWorkAccountability?: (
    work: CollectiveWorkProjection,
    request: NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number],
    decision: 'accept' | 'decline',
    participant?: CollectiveParticipant,
  ) => Promise<void>;
  readonly onDecideProjectSuggestion?: ProjectSuggestionDecisionHandler;
  readonly onSetRoadmapWorks: (roadmap: CollectiveRoadmapRecord, workIds: readonly string[]) => Promise<void>;
  readonly onSetRoadmapStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') => Promise<void>;
  readonly roadmapView?: RoadmapViewState;
  readonly onRoadmapViewChange: (view: RoadmapViewState) => void;
  readonly onOpenRoadmapSource: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenRoadmapResult: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly roadmapReturnLabel?: string;
  readonly onReturnToRoadmap?: () => void;
  readonly onCreateVote: (sourceEventId: string, draft: InformalVoteDraft) => Promise<void>;
  readonly onCastVote: (vote: CollectiveVoteProjection, optionId: string) => Promise<void>;
  readonly onCloseVote: (vote: CollectiveVoteProjection) => Promise<void>;
  readonly onCreateBindingVote: (roadmap: CollectiveRoadmapRecord, draft: VoteDraft) => Promise<void>;
  readonly onCastBindingVote: (
    vote: CollectiveBindingVoteProjection,
    choice: CollectiveBindingVoteChoice,
  ) => Promise<void>;
  readonly onWithdrawBindingVote: (vote: CollectiveBindingVoteProjection) => Promise<void>;
  readonly onSettleBindingVote: (vote: CollectiveBindingVoteProjection) => Promise<void>;
  readonly onChangeWorkTime?: WorkTimeChangeHandler;
  readonly onChangeProjectTarget?: ProjectTargetChangeHandler;
  readonly onSetWorkDependencies: (
    work: CollectiveWorkProjection,
    dependencyWorkIds: readonly string[],
  ) => Promise<void>;
  readonly onSetReaction: (eventId: string, emoji: CollectiveReactionEmoji, active: boolean) => Promise<void>;
  readonly onOpenNavigation: () => void;
  readonly onOpenMember: (event: CollectiveEventEnvelope) => void;
  readonly onOpenTopic: () => void;
  readonly onOpenChannel?: (channelId: string, eventId?: string) => void;
  readonly onOpenLibrary?: (channelId: string) => void;
  readonly context?: ReactNode;
  readonly contextFullPage?: boolean;
  readonly hostActivity?: boolean;
  readonly onMembers?: () => void;
  readonly onSearch?: () => void;
  readonly onCafe?: () => void;
  readonly onChannelCafe?: () => void;
  readonly members?: CollectiveMemberDirectory;
  readonly firstEntry?: FirstEntryGuide;
}
