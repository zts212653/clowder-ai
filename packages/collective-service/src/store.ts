import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLECTIVE_CLIENT_BUILD_ID } from '@cat-cafe/collective-client';
import { CollectiveBindingVoteStore } from './collaboration-binding-vote-store.js';
import { CollectiveReactionStore } from './collaboration-reaction-store.js';
import { CollectiveCollaborationStore } from './collaboration-store.js';
import { CollectiveConnectionEventStore, type PairingExchangeInput } from './connection-event-store.js';
import { CollectiveServiceError } from './errors.js';
import type { HumanAuthProvider, HumanAuthProviderId } from './human-auth-provider.js';
import { CollectiveIdentityStore } from './identity-store.js';
import { readMemberDirectory } from './member-directory.js';
import { leaveCollectiveMembership } from './membership-lifecycle.js';
import { CollectiveParticipationStore } from './participation-store.js';
import {
  createSecret,
  createStableId,
  digestSecret,
  PersistentServiceState,
  SERVICE_STATE_FILE,
} from './persistence.js';
import type { ServiceState } from './state.js';
import { CollectiveWorkPolicyStore } from './work-policy-store.js';

export interface OpenCollectiveServiceStoreOptions {
  readonly dataDirectory: string;
  readonly now?: () => number;
  readonly bootstrapTtlMs?: number;
  readonly humanAuthProvider?: HumanAuthProvider;
  readonly humanAuthRedirectUri?: string;
}

export interface OpenedCollectiveServiceStore {
  readonly store: CollectiveServiceStore;
  readonly bootstrapSecret?: string;
}

export class CollectiveServiceStore {
  readonly #identity: CollectiveIdentityStore;
  readonly #connections: CollectiveConnectionEventStore;
  readonly #participation: CollectiveParticipationStore;
  readonly #collaboration: CollectiveCollaborationStore;
  readonly #bindingVotes: CollectiveBindingVoteStore;
  readonly #reactions: CollectiveReactionStore;
  readonly #workPolicy: CollectiveWorkPolicyStore;

  private constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
    humanAuthProvider?: HumanAuthProvider,
    humanAuthRedirectUri?: string,
  ) {
    this.#identity = new CollectiveIdentityStore(persistence, now, humanAuthProvider, humanAuthRedirectUri);
    this.#connections = new CollectiveConnectionEventStore(persistence, now);
    this.#participation = new CollectiveParticipationStore(persistence, now);
    this.#collaboration = new CollectiveCollaborationStore(persistence, now);
    this.#bindingVotes = new CollectiveBindingVoteStore(persistence, now);
    this.#reactions = new CollectiveReactionStore(persistence, now);
    this.#workPolicy = new CollectiveWorkPolicyStore(persistence, now);
  }

  static async open(options: OpenCollectiveServiceStoreOptions): Promise<OpenedCollectiveServiceStore> {
    const now = options.now ?? Date.now;
    const stateFile = join(options.dataDirectory, SERVICE_STATE_FILE);
    try {
      await access(stateFile);
      const persistence = await PersistentServiceState.load(options.dataDirectory);
      return {
        store: new CollectiveServiceStore(persistence, now, options.humanAuthProvider, options.humanAuthRedirectUri),
      };
    } catch (error) {
      if (error instanceof CollectiveServiceError) throw error;
      if (!isMissingFile(error)) {
        throw new CollectiveServiceError(
          'STATE_CORRUPT',
          `Collective Service state could not be loaded: ${errorMessage(error)}`,
          500,
        );
      }
      const bootstrapSecret = createSecret();
      const createdAt = new Date(now()).toISOString();
      const state: ServiceState = {
        schemaVersion: 2,
        serviceInstanceId: createStableId('svc_'),
        createdAt,
        bootstrap: {
          tokenDigest: digestSecret(bootstrapSecret),
          expiresAt: new Date(now() + (options.bootstrapTtlMs ?? 24 * 60 * 60 * 1_000)).toISOString(),
        },
        humans: {},
        sessions: {},
        humanAuthBindings: {},
        humanAuthAttempts: {},
        humanAuthCompletions: {},
        collectives: {},
        memberships: {},
        invites: {},
        pairingIntents: {},
        connections: {},
        events: {},
        participations: {},
        works: {},
        roadmaps: {},
        votes: {},
        bindingVotes: {},
        decisions: {},
        reactions: {},
        collaborationOperations: {},
        legacyEvents: {},
        clientEventIndex: {},
      };
      const persistence = await PersistentServiceState.create(options.dataDirectory, state);
      return {
        store: new CollectiveServiceStore(persistence, now, options.humanAuthProvider, options.humanAuthRedirectUri),
        bootstrapSecret,
      };
    }
  }

  get serviceInstanceId(): string {
    return this.persistence.snapshot().serviceInstanceId;
  }

  getMetadata() {
    const state = this.persistence.snapshot();
    const ownerHumanId = state.bootstrap.ownerHumanId;
    return {
      serviceInstanceId: state.serviceInstanceId,
      createdAt: state.createdAt,
      bootstrapNeeded: state.bootstrap.consumedAt === undefined,
      onboardingComplete:
        state.bootstrap.consumedAt !== undefined &&
        ownerHumanId !== undefined &&
        Object.values(state.humanAuthBindings).some((binding) => binding.humanId === ownerHumanId) &&
        Object.keys(state.collectives).length > 0,
      clientBuildId: COLLECTIVE_CLIENT_BUILD_ID,
    };
  }

  consumeBootstrap(input: { secret: string; displayName: string }) {
    return this.#identity.consumeBootstrap(input);
  }

  requireSession(sessionToken: string) {
    return this.#identity.requireSession(sessionToken);
  }

  authorizeProviderSetup(input: { readonly bootstrapSecret?: string; readonly sessionToken?: string }) {
    return this.#identity.authorizeProviderSetup(input);
  }

  createCollective(input: { sessionToken: string; name: string }) {
    return this.#identity.createCollective(input);
  }

  listCollectives(sessionToken: string) {
    return this.#identity.listCollectives(sessionToken);
  }

  getHumanProjection(sessionToken: string) {
    return this.#identity.getHumanProjection(sessionToken);
  }

  createInvite(input: { sessionToken: string; collectiveId: string; ttlMs?: number }) {
    return this.#identity.createInvite(input);
  }

  getHumanAuthProviders() {
    return this.#identity.getHumanAuthProviders();
  }

  getHumanAuthRedirectUri() {
    return this.#identity.getHumanAuthRedirectUri();
  }

  beginHumanAuth(input: Parameters<CollectiveIdentityStore['beginHumanAuth']>[0]) {
    return this.#identity.beginHumanAuth(input);
  }

  completeHumanAuth(input: { provider: HumanAuthProviderId; state: string; code: string; ttlMs?: number }) {
    return this.#identity.completeHumanAuth(input);
  }

  exchangeHumanAuthCompletion(completionToken: string) {
    return this.#identity.exchangeHumanAuthCompletion(completionToken);
  }

  joinInvite(input: { inviteToken: string; displayName: string }) {
    return this.#identity.joinInvite(input);
  }

  leaveCollective(input: { sessionToken: string; collectiveId: string }) {
    return leaveCollectiveMembership(this.persistence, this.now, input);
  }

  createPairingIntent(input: {
    sessionToken: string;
    collectiveId: string;
    hostOrigin: string;
    nonce: string;
    ttlMs?: number;
  }) {
    return this.#connections.createPairingIntent(input);
  }

  exchangePairingIntent(input: PairingExchangeInput) {
    return this.#connections.exchangePairingIntent(input);
  }

  postHumanMessage(sessionToken: string, input: unknown) {
    return this.#connections.postHumanMessage(sessionToken, input);
  }

  postAgentMessage(endpointCredential: string, input: unknown) {
    return this.#connections.postAgentMessage(endpointCredential, input);
  }

  listEventsForHuman(sessionToken: string, collectiveId: string) {
    return this.#connections.listEventsForHuman(sessionToken, collectiveId);
  }

  pollEvents(endpointCredential: string, input: unknown) {
    return this.#connections.pollEvents(endpointCredential, input);
  }

  acknowledge(endpointCredential: string, input: unknown) {
    return this.#connections.acknowledge(endpointCredential, input);
  }

  revokeConnection(input: { sessionToken: string; collectiveId: string; connectionId: string }) {
    return this.#connections.revokeConnection(input);
  }

  revokeOwnConnection(endpointCredential: string, input: unknown) {
    return this.#connections.revokeOwnConnection(endpointCredential, input);
  }

  getConnectionProjection(connectionId: string) {
    return this.#connections.getConnectionProjection(connectionId);
  }

  publishParticipation(endpointCredential: string, input: unknown) {
    return this.#participation.publish(endpointCredential, input);
  }
  readParticipationDeclaration(endpointCredential: string, input: unknown) {
    return this.#participation.readDeclaration(endpointCredential, input);
  }
  listParticipants(sessionToken: string, collectiveId: string) {
    return this.#participation.list(sessionToken, collectiveId);
  }

  listMembers(sessionToken: string, collectiveId: string) {
    return readMemberDirectory(this.persistence.snapshot(), sessionToken, collectiveId);
  }
  readParticipationContext(endpointCredential: string, input: unknown) {
    return this.#participation.readContext(endpointCredential, input);
  }

  proposeCollectiveWork(sessionToken: string, input: unknown) {
    return this.#collaboration.proposeHumanWork(sessionToken, input);
  }

  readAssignedWork(endpointCredential: string, input: unknown) {
    return this.#collaboration.readAssignedWork(endpointCredential, input);
  }

  readAssignedWorkByAssignment(endpointCredential: string, input: unknown) {
    return this.#collaboration.readAssignedWorkByAssignment(endpointCredential, input);
  }

  proposeCollectiveWorkAsAgent(endpointCredential: string, input: unknown) {
    return this.#collaboration.proposeAgentWork(endpointCredential, input);
  }

  commitCollectiveWork(sessionToken: string, input: unknown) {
    return this.#collaboration.commitWork(sessionToken, input);
  }

  setCollectiveWorkDependencies(sessionToken: string, input: unknown) {
    return this.#collaboration.setWorkDependencies(sessionToken, input);
  }

  declineCollectiveWork(sessionToken: string, input: unknown) {
    return this.#collaboration.declineWork(sessionToken, input);
  }

  acceptCollectiveWorkResult(sessionToken: string, input: unknown) {
    return this.#collaboration.acceptWorkResult(sessionToken, input);
  }

  requestCollectiveWorkRevision(sessionToken: string, input: unknown) {
    return this.#collaboration.requestWorkRevision(sessionToken, input);
  }

  completeCollectiveWork(sessionToken: string, input: unknown) {
    return this.#collaboration.completeWork(sessionToken, input);
  }

  createCollectiveRoadmap(sessionToken: string, input: unknown) {
    return this.#collaboration.createRoadmap(sessionToken, input);
  }

  setCollectiveRoadmapWorks(sessionToken: string, input: unknown) {
    return this.#collaboration.setRoadmapWorks(sessionToken, input);
  }

  setCollectiveRoadmapStatus(sessionToken: string, input: unknown) {
    return this.#collaboration.setRoadmapStatus(sessionToken, input);
  }

  createCollectiveVote(sessionToken: string, input: unknown) {
    return this.#collaboration.createVote(sessionToken, input);
  }

  castCollectiveVote(sessionToken: string, input: unknown) {
    return this.#collaboration.castVote(sessionToken, input);
  }

  closeCollectiveVote(sessionToken: string, input: unknown) {
    return this.#collaboration.closeVote(sessionToken, input);
  }

  createCollectiveBindingVote(sessionToken: string, input: unknown) {
    return this.#bindingVotes.create(sessionToken, input);
  }

  castCollectiveBindingVote(sessionToken: string, input: unknown) {
    return this.#bindingVotes.cast(sessionToken, input);
  }

  withdrawCollectiveBindingVote(sessionToken: string, input: unknown) {
    return this.#bindingVotes.withdraw(sessionToken, input);
  }

  settleCollectiveBindingVote(sessionToken: string, input: unknown) {
    return this.#bindingVotes.settle(sessionToken, input);
  }

  setCollectiveReaction(sessionToken: string, input: unknown) {
    return this.#reactions.set(sessionToken, input);
  }

  registerCollectiveWorkPolicy(sessionToken: string, input: unknown) {
    return this.#workPolicy.register(sessionToken, input);
  }
  readCollectiveWorkPolicy(endpointCredential: string, input: unknown) {
    return this.#workPolicy.read(endpointCredential, input);
  }
  readOwnerCollectiveWorkPolicy(sessionToken: string, input: unknown) {
    return this.#workPolicy.readOwner(sessionToken, input);
  }
  revokeCollectiveWorkPolicy(endpointCredential: string, input: unknown) {
    return this.#workPolicy.revoke(endpointCredential, input);
  }
  acceptCollectiveWorkAsAgent(endpointCredential: string, input: unknown) {
    return this.#collaboration.acceptAgentWork(endpointCredential, input);
  }
  continueCollectiveWorkAsAgent(endpointCredential: string, input: unknown) {
    return this.#collaboration.continueAgentWork(endpointCredential, input);
  }
  readCollectiveWorkSourceContext(endpointCredential: string, input: unknown) {
    return this.#collaboration.readSourceContext(endpointCredential, input);
  }
  readCollectiveWorkRoutingContext(endpointCredential: string, input: unknown) {
    return this.#collaboration.readRoutingContext(endpointCredential, input);
  }
  recordCollectiveWorkHostAdmission(endpointCredential: string, input: unknown) {
    return this.#collaboration.recordHostAdmission(endpointCredential, input);
  }

  listCollectiveCollaboration(sessionToken: string, collectiveId: string) {
    return {
      ...this.#collaboration.list(sessionToken, collectiveId),
      ...this.#bindingVotes.list(sessionToken, collectiveId),
      reactions: this.#reactions.list(sessionToken, collectiveId),
    };
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { CollectiveServiceError } from './errors.js';
