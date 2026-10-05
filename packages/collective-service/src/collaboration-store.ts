import {
  acceptCollectiveWorkResultRequestSchema,
  type CollectiveCollaborationActor,
  castCollectiveVoteRequestSchema,
  closeCollectiveVoteRequestSchema,
  collectiveAcceptWorkRequestSchema,
  collectiveAgentWorkProposalRequestSchema,
  collectiveAssignedWorkByAssignmentReadRequestSchema,
  collectiveAssignedWorkReadRequestSchema,
  collectiveContinueWorkRequestSchema,
  collectiveWorkHostAdmissionRequestSchema,
  collectiveWorkRoutingReadRequestSchema,
  collectiveWorkSourceReadRequestSchema,
  commitCollectiveWorkRequestSchema,
  completeCollectiveWorkRequestSchema,
  createCollectiveRoadmapRequestSchema,
  createCollectiveVoteRequestSchema,
  declineCollectiveWorkRequestSchema,
  proposeCollectiveWorkRequestSchema,
  requestCollectiveWorkRevisionRequestSchema,
  setCollectiveRoadmapStatusRequestSchema,
  setCollectiveRoadmapWorksRequestSchema,
  setCollectiveWorkDependenciesRequestSchema,
} from '@cat-cafe/shared';
import { acceptCollectiveWorkAsAgent } from './collaboration-agent-acceptance.js';
import { continueCollectiveWorkAsAgent } from './collaboration-agent-continuation.js';
import {
  advanceWork,
  byCreation,
  createWorkProposal,
  humanActor,
  mutableWork,
  requireHumanCommand,
  requireWorkSource,
} from './collaboration-command-helpers.js';
import { commitCollectiveWork } from './collaboration-commit.js';
import { completeCollectiveWork } from './collaboration-complete.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { requestCollectiveWorkRevision } from './collaboration-revision.js';
import {
  createCollectiveRoadmap,
  setCollectiveRoadmapStatus,
  setCollectiveRoadmapWorks,
} from './collaboration-roadmap.js';
import {
  castCollectiveVote,
  closeCollectiveVote,
  createCollectiveVote,
  projectCollectiveVote,
} from './collaboration-vote.js';
import {
  assertDependencySet,
  projectCollectiveWork,
  requireCollectiveWork,
  requireWorkAccountableHuman,
  requireWorkRevision,
} from './collaboration-work.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import { requireParticipant, sourceAuthorizesParticipant } from './participation-store.js';
import type { PersistentServiceState } from './persistence.js';
import { recordWorkHostAdmission } from './work-host-admission.js';
import { readWorkRoutingContext, readWorkSourceContext } from './work-source-context.js';

export class CollectiveCollaborationStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async acceptAgentWork(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveAcceptWorkRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) =>
      acceptCollectiveWorkAsAgent(state, endpointCredential, input, this.now()),
    );
  }

  async continueAgentWork(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveContinueWorkRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) =>
      continueCollectiveWorkAsAgent(state, endpointCredential, input, this.now()),
    );
  }

  async recordHostAdmission(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveWorkHostAdmissionRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) =>
      recordWorkHostAdmission(state, endpointCredential, input, this.now()),
    );
  }

  async proposeHumanWork(sessionToken: string, unsafeInput: unknown) {
    const input = proposeCollectiveWorkRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return createWorkProposal(state, input, humanActor(human), `human:${human.humanId}`, this.now());
    });
  }

  readAssignedWork(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveAssignedWorkReadRequestSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, endpointCredential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    const human = requireAuthorizedHuman(state, connection);
    const work = requireCollectiveWork(state, input.collectiveId, input.workId);
    if (work.assignment?.connectionId !== connection.connectionId || work.assignment.humanId !== human.humanId) {
      throw new CollectiveServiceError(
        'WORK_AUTHORITY_REQUIRED',
        'This endpoint is not the assigned Café for the requested Work',
        403,
      );
    }
    return projectCollectiveWork(state, work, this.now());
  }

  readSourceContext(endpointCredential: string, unsafeInput: unknown) {
    return readWorkSourceContext(
      this.persistence.snapshot(),
      endpointCredential,
      collectiveWorkSourceReadRequestSchema.parse(unsafeInput),
      this.now(),
    );
  }
  readRoutingContext(endpointCredential: string, unsafeInput: unknown) {
    return readWorkRoutingContext(
      this.persistence.snapshot(),
      endpointCredential,
      collectiveWorkRoutingReadRequestSchema.parse(unsafeInput),
      this.now(),
    );
  }

  readAssignedWorkByAssignment(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveAssignedWorkByAssignmentReadRequestSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, endpointCredential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    const human = requireAuthorizedHuman(state, connection);
    const matches = Object.values(state.works).filter(
      (work) => work.collectiveId === input.collectiveId && work.assignmentEventId === input.assignmentEventId,
    );
    if (matches.length !== 1) {
      throw new CollectiveServiceError(
        matches.length === 0 ? 'WORK_NOT_FOUND' : 'STATE_CORRUPT',
        matches.length === 0
          ? 'Collective Work was not found for this assignment'
          : 'Collective assignment resolves to multiple Works',
        matches.length === 0 ? 404 : 409,
      );
    }
    const work = matches[0];
    if (
      !work ||
      work.assignment?.connectionId !== connection.connectionId ||
      work.assignment.humanId !== human.humanId
    ) {
      throw new CollectiveServiceError(
        'WORK_AUTHORITY_REQUIRED',
        'This endpoint is not the assigned Café for the requested Work',
        403,
      );
    }
    return projectCollectiveWork(state, work, this.now());
  }

  async proposeAgentWork(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveAgentWorkProposalRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, endpointCredential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const human = requireAuthorizedHuman(state, connection);
      const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
      const participant = requireParticipant(state, {
        ...input,
        humanId: human.humanId,
        channelId: source.location.channelId,
      });
      if (!sourceAuthorizesParticipant(source, { ...input, humanId: human.humanId })) {
        throw new CollectiveServiceError(
          'PARTICIPATION_REVOKED',
          'The current public source does not authorize this Cat proposal',
          403,
        );
      }
      const actor: CollectiveCollaborationActor = {
        kind: 'agent',
        humanId: human.humanId,
        humanDisplayName: human.displayName,
        connectionId: connection.connectionId,
        catId: participant.catId,
        displayName: participant.displayName,
      };
      return createWorkProposal(
        state,
        input,
        actor,
        `connection:${connection.connectionId}:cat:${participant.catId}`,
        this.now(),
      );
    });
  }

  async commitWork(sessionToken: string, unsafeInput: unknown) {
    const input = commitCollectiveWorkRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return commitCollectiveWork(state, input, human, this.now());
    });
  }

  async setWorkDependencies(sessionToken: string, unsafeInput: unknown) {
    const input = setCollectiveWorkDependenciesRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      const actorScope = `human:${human.humanId}`;
      const replay = collaborationOperationReplay(state, {
        ...input,
        actorScope,
        payload: input,
        resourceKind: 'work',
      });
      if (replay.existing)
        return projectCollectiveWork(
          state,
          requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
          this.now(),
        );
      const work = mutableWork(state, input.collectiveId, input.workId);
      requireWorkRevision(work, input.expectedRevision);
      requireWorkAccountableHuman(work, human.humanId);
      assertDependencySet(state, work, input.dependencyWorkIds);
      work.dependencyWorkIds = [...input.dependencyWorkIds];
      const at = new Date(this.now()).toISOString();
      advanceWork(work, 'dependencies_changed', humanActor(human), at);
      recordCollaborationOperation(state, {
        ...replay,
        actorScope,
        resourceKind: 'work',
        resourceId: work.workId,
        revision: work.revision,
        recordedAt: at,
      });
      return projectCollectiveWork(state, work, this.now());
    });
  }

  async completeWork(sessionToken: string, unsafeInput: unknown) {
    const input = completeCollectiveWorkRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return completeCollectiveWork(state, input, human, this.now());
    });
  }

  async declineWork(sessionToken: string, unsafeInput: unknown) {
    const input = declineCollectiveWorkRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      const actorScope = `human:${human.humanId}`;
      const replay = collaborationOperationReplay(state, {
        ...input,
        actorScope,
        payload: input,
        resourceKind: 'work',
      });
      if (replay.existing)
        return projectCollectiveWork(
          state,
          requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
          this.now(),
        );
      const work = mutableWork(state, input.collectiveId, input.workId);
      requireWorkRevision(work, input.expectedRevision);
      if (work.lifecycle !== 'proposed') {
        throw new CollectiveServiceError('WORK_NOT_PROPOSED', 'Only a proposed Work can be declined', 409);
      }
      const source = requireWorkSource(state, input.collectiveId, work.sourceEventId);
      const membership = requireMembership(state, input.collectiveId, human.humanId);
      const ownsProposal = work.proposedBy.humanId === human.humanId;
      const sourceHumanId = source.actor.kind === 'human' ? source.actor.humanId : source.actor.human.humanId;
      const ownsSource = sourceHumanId === human.humanId;
      if (!ownsProposal && !ownsSource && membership.role !== 'steward') {
        throw new CollectiveServiceError(
          'WORK_AUTHORITY_REQUIRED',
          'Only the source owner or steward can decline',
          403,
        );
      }
      work.lifecycle = 'declined';
      const at = new Date(this.now()).toISOString();
      advanceWork(work, 'declined', humanActor(human), at, undefined, input.reason);
      recordCollaborationOperation(state, {
        ...replay,
        actorScope,
        resourceKind: 'work',
        resourceId: work.workId,
        revision: work.revision,
        recordedAt: at,
      });
      return projectCollectiveWork(state, work, this.now());
    });
  }

  async acceptWorkResult(sessionToken: string, unsafeInput: unknown) {
    const input = acceptCollectiveWorkResultRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      const actorScope = `human:${human.humanId}`;
      const replay = collaborationOperationReplay(state, {
        ...input,
        actorScope,
        payload: input,
        resourceKind: 'work',
      });
      if (replay.existing)
        return projectCollectiveWork(
          state,
          requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId),
          this.now(),
        );
      const work = mutableWork(state, input.collectiveId, input.workId);
      requireWorkRevision(work, input.expectedRevision);
      requireWorkAccountableHuman(work, human.humanId);
      const resultRevision = work.resultEventId ? (work.resultRevision ?? 1) : undefined;
      if (work.lifecycle !== 'result_ready' || !work.resultEventId) {
        throw new CollectiveServiceError('WORK_RESULT_UNAVAILABLE', 'Work has no returned result to accept', 409);
      }
      if (work.resultEventId !== input.resultEventId || resultRevision !== input.resultRevision) {
        throw new CollectiveServiceError(
          'WORK_RESULT_NOT_CURRENT',
          'Only the current returned result can be accepted',
          409,
        );
      }
      work.lifecycle = 'completed';
      const at = new Date(this.now()).toISOString();
      advanceWork(work, 'result_accepted', humanActor(human), at, work.resultEventId, undefined, resultRevision);
      recordCollaborationOperation(state, {
        ...replay,
        actorScope,
        resourceKind: 'work',
        resourceId: work.workId,
        revision: work.revision,
        recordedAt: at,
      });
      return projectCollectiveWork(state, work, this.now());
    });
  }

  async requestWorkRevision(sessionToken: string, unsafeInput: unknown) {
    const input = requestCollectiveWorkRevisionRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return requestCollectiveWorkRevision(state, input, human, this.now());
    });
  }

  async createRoadmap(sessionToken: string, unsafeInput: unknown) {
    const input = createCollectiveRoadmapRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return createCollectiveRoadmap(state, input, human, this.now());
    });
  }

  async setRoadmapWorks(sessionToken: string, unsafeInput: unknown) {
    const input = setCollectiveRoadmapWorksRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return setCollectiveRoadmapWorks(state, input, human, this.now());
    });
  }

  async setRoadmapStatus(sessionToken: string, unsafeInput: unknown) {
    const input = setCollectiveRoadmapStatusRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return setCollectiveRoadmapStatus(state, input, human, this.now());
    });
  }

  async createVote(sessionToken: string, unsafeInput: unknown) {
    const input = createCollectiveVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return createCollectiveVote(state, input, human, this.now());
    });
  }

  async castVote(sessionToken: string, unsafeInput: unknown) {
    const input = castCollectiveVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return castCollectiveVote(state, input, human, this.now());
    });
  }

  async closeVote(sessionToken: string, unsafeInput: unknown) {
    const input = closeCollectiveVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return closeCollectiveVote(state, input, human, this.now());
    });
  }

  list(sessionToken: string, collectiveId: string) {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    requireMembership(state, collectiveId, human.humanId);
    return {
      serviceInstanceId: state.serviceInstanceId,
      collectiveId,
      works: Object.values(state.works)
        .filter((work) => work.collectiveId === collectiveId)
        .sort(byCreation)
        .map((work) => projectCollectiveWork(state, work, this.now())),
      roadmaps: Object.values(state.roadmaps)
        .filter((roadmap) => roadmap.collectiveId === collectiveId)
        .sort(byCreation)
        .map((roadmap) => structuredClone(roadmap)),
      votes: Object.values(state.votes)
        .filter((vote) => vote.collectiveId === collectiveId)
        .sort(byCreation)
        .map((vote) => projectCollectiveVote(vote, this.now())),
    };
  }
}
