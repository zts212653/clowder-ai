import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactAction,
  type CollectiveArtifactAgentContext,
  type CollectiveMediaReadRequest,
  type CollectivePairingIntent,
  type CollectiveProjectWorkSuggestionTarget,
  type CollectiveRetainedMediaRegistrationRequest,
  type CollectiveSourceIdentity,
  type CollectiveWorkHostAdmissionRequest,
  type CollectiveWorkProjection,
  type CollectiveWorkResultTextSource,
  collectivePairingIntentSchema,
  type RegisterCollectiveArtifact,
} from '@cat-cafe/shared';
import {
  type AcceptedWorkResultFileSeal,
  reconcileAcceptedWorkResultFiles,
} from './accepted-work-result-file-reconciliation.js';
import type { CollectiveArtifactOwnerPort } from './artifact-owner-client.js';
import { ConnectorArtifactOwnerRelay } from './artifact-owner-relay.js';
import { type StandingInterestInput, setStandingInterest } from './attention-custody.js';
import { type ChannelListeningInput, setChannelListening } from './channel-listening-custody.js';
import type { CollectiveConnectorOptions } from './connector-options.js';
import { type ConnectorSyncHooks, ConnectorSynchronization } from './connector-synchronization.js';
import { desiredParticipationSchema } from './host-route-state.js';
import {
  prepareReplyOperation,
  queueVerifiedAgentMessage,
  readPublicReplyOperation,
  submitReplyOperation,
} from './outbox-custody.js';
import { participationDeclaration, participationError, requireParticipation } from './participation-custody.js';
import { ConnectorPersistence } from './persistence.js';
import { type ConnectorProjection, projectConnection } from './projection.js';
import {
  beginInboxRouting,
  completeInboxRouting,
  failInboxRouting,
  getHostRoute,
  listInboxForRouting,
  setHostRoute,
} from './route-custody.js';
import { CollectiveServiceClient, ConnectorTransportError } from './service-client.js';
import {
  type ConnectorConnectionState,
  type ConnectorInboxItem,
  type ConnectorRouteFailure,
  type ConnectorRouteReceipt,
  type HostRouteConfig,
  type SetHostRouteInput,
  type VerifiedAgent,
  verifiedAgentSchema,
  type WorkResultArtifactSnapshot,
} from './state.js';
import { type CollectiveWorkAcceptanceInput, ConnectorWorkAcceptanceCustody } from './work-acceptance-custody.js';
import { type CollectiveWorkContinuationInput, ConnectorWorkContinuationCustody } from './work-continuation-custody.js';
import { ConnectorWorkPolicyCustody, workCoordinates } from './work-policy-custody.js';
import {
  type CollectiveProgressPurpose,
  prepareProgressOperation,
  submitProgressOperation,
} from './work-progress-custody.js';
import { proposeVerifiedCollectiveWork } from './work-proposal.js';
import {
  prepareWorkReconsideration,
  type WorkReconsiderationAuthorityScope,
  type WorkReconsiderationInput,
} from './work-reconsideration.js';
import {
  type CollectiveWorkResultPublication,
  type CollectiveWorkResultPublicationCandidate,
  projectWorkResultPublications,
  workResultBodyLinksTextSource,
} from './work-result-publication.js';

export type { ConnectorSyncHooks } from './connector-synchronization.js';

export interface AssignedWorkAuthorityScope {
  readonly connection: ConnectorProjection;
  readonly hostRoute?: HostRouteConfig;
  readonly inbox: readonly ConnectorInboxItem[];
  readonly work: CollectiveWorkProjection;
  readonly resultPublications: readonly CollectiveWorkResultPublication[];
  readonly recordHostAdmission: (
    input: Omit<CollectiveWorkHostAdmissionRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) => Promise<void>;
}

export class CollectiveConnector {
  private readonly synchronization: ConnectorSynchronization;
  private readonly workPolicy: ConnectorWorkPolicyCustody;
  private readonly workAcceptance: ConnectorWorkAcceptanceCustody;
  private readonly workContinuation: ConnectorWorkContinuationCustody;
  private readonly authorityTails = new Map<string, Promise<void>>();
  private readonly artifactOwner: ConnectorArtifactOwnerRelay;

  private constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
    private readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>,
    private readonly now: () => number,
  ) {
    this.artifactOwner = new ConnectorArtifactOwnerRelay(persistence, service);
    this.synchronization = new ConnectorSynchronization(persistence, service, now, (source) =>
      this.workAcceptance.resolveGrant(source),
    );
    this.workPolicy = new ConnectorWorkPolicyCustody(persistence, service.workAuthority, now);
    this.workAcceptance = new ConnectorWorkAcceptanceCustody(persistence, service, this.workPolicy, verifyAgent, now);
    this.workContinuation = new ConnectorWorkContinuationCustody(
      persistence,
      service,
      this.workPolicy,
      verifyAgent,
      now,
    );
  }

  static async open(options: CollectiveConnectorOptions): Promise<CollectiveConnector> {
    return new CollectiveConnector(
      await ConnectorPersistence.open(options.dataDirectory),
      new CollectiveServiceClient(options.fetchImpl),
      options.verifyAgent,
      options.now ?? Date.now,
    );
  }

  async pair(input: {
    serviceUrl: string;
    intent: CollectivePairingIntent;
    endpointLabel: string;
    initialExcludedCatIds?: readonly string[];
  }): Promise<ConnectorProjection> {
    const intent = collectivePairingIntentSchema.parse(input.intent);
    const serviceUrl = new URL(input.serviceUrl).origin;
    const initialExcludedCatIds = desiredParticipationSchema.parse({
      defaultMode: 'include',
      excludedCatIds: input.initialExcludedCatIds ?? [],
      channelOverrides: {},
    }).excludedCatIds;
    return this.withAuthority(`pair:${intent.serviceInstanceId}:${intent.collectiveId}`, async () => {
      const metadata = await this.service.readMetadata(serviceUrl);
      if (metadata.serviceInstanceId !== intent.serviceInstanceId) {
        throw new Error('Pairing intent belongs to another Collective Service');
      }
      const alreadyConnected = Object.values(this.persistence.snapshot().connections).some(
        (connection) =>
          connection.serviceInstanceId === intent.serviceInstanceId &&
          connection.collectiveId === intent.collectiveId &&
          connection.authorityStatus !== 'revoked',
      );
      if (alreadyConnected) throw new Error('This Café is already connected to this Collective');
      const paired = await this.service.exchangePairing(serviceUrl, intent, input.endpointLabel);
      if (paired.serviceInstanceId !== intent.serviceInstanceId || paired.collectiveId !== intent.collectiveId) {
        throw new Error('Pairing response coordinates do not match the intent');
      }
      const connection: ConnectorConnectionState = {
        serviceUrl,
        clientBuildId: metadata.clientBuildId,
        serviceInstanceId: paired.serviceInstanceId,
        collectiveId: paired.collectiveId,
        connectionId: paired.connectionId,
        endpointId: paired.endpointId,
        authorizedHumanId: paired.authorizedHumanId,
        endpointLabel: input.endpointLabel.trim(),
        endpointCredential: paired.endpointCredential,
        ...(initialExcludedCatIds.length ? { initialExcludedCatIds: [...new Set(initialExcludedCatIds)].sort() } : {}),
        authorityStatus: 'connected',
        liveStatus: 'online',
        lastAckedSequence: 0,
        outbox: [],
        inbox: [],
        createdAt: new Date(this.now()).toISOString(),
      };
      await this.persistence.transaction((state) => {
        state.connections[connection.connectionId] = connection;
      });
      return projectConnection(connection);
    });
  }

  async queueAgentMessage(connectionId: string, unsafeInput: unknown): Promise<ConnectorProjection> {
    return queueVerifiedAgentMessage({
      persistence: this.persistence,
      verifyAgent: this.verifyAgent,
      now: this.now,
      connectionId,
      unsafeInput,
    });
  }

  async sync(connectionId: string, hooks: ConnectorSyncHooks = {}): Promise<ConnectorProjection> {
    const projection = await this.withAuthority(connectionId, async () => {
      const projection = await this.synchronization.sync(connectionId, hooks);
      // An offline Service cannot settle receipts yet. A revoked endpoint may only finish its original receipt.
      if (projection.liveStatus === 'online' || projection.authorityStatus === 'revoked')
        await this.artifactOwner.recoverPublications(connectionId);
      if (projection.authorityStatus === 'connected' && projection.liveStatus === 'online') {
        await this.workPolicy.flushRevocations(connectionId, true);
        await this.workAcceptance.recover(connectionId);
        await this.workContinuation.recover(connectionId);
        await this.artifactOwner.sync(connectionId);
      }
      return this.getProjection(connectionId);
    });
    if (projection.authorityStatus === 'connected' && projection.liveStatus === 'online')
      await this.artifactOwner.media.sync(connectionId);
    return this.getProjection(connectionId);
  }

  async openArtifactMedia(
    connectionId: string,
    ownerUserId: string,
    input: Omit<CollectiveMediaReadRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
    signal: AbortSignal,
  ) {
    const admission = this.artifactOwner.media.readAdmission();
    const open = await this.withAuthority(connectionId, async () =>
      this.artifactOwner.media.prepareRead(connectionId, ownerUserId, input, signal, admission),
    );
    return open();
  }
  stopMediaReads() {
    return this.artifactOwner.media.stop();
  }

  setArtifactOwner(owner: CollectiveArtifactOwnerPort | undefined) {
    this.artifactOwner.setOwner(owner);
  }
  registerArtifact(
    connectionId: string,
    ownerUserId: string,
    input: Omit<RegisterCollectiveArtifact, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    return this.withAuthority(connectionId, () => this.artifactOwner.register(connectionId, ownerUserId, input));
  }
  readArtifactRegistrationContext(
    connectionId: string,
    ownerUserId: string,
    input: Omit<CollectiveRetainedMediaRegistrationRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    return this.withAuthority(connectionId, () =>
      this.artifactOwner.registrationContext(connectionId, ownerUserId, input),
    );
  }

  /** RPC payloads never enter the Channel outbox. Release the lock so this Cafe can also serve the owner poll. */
  async requestArtifactForAgent(
    source: CollectiveSourceIdentity,
    unsafeAgent: VerifiedAgent,
    input: {
      artifactId: string;
      sourceEventId: string;
      action: CollectiveArtifactAction;
      ownerRevision?: number;
      requestId: string;
      payload: Record<string, unknown>;
    },
  ) {
    const agent = verifiedAgentSchema.parse(unsafeAgent);
    const validate = async () => {
      const bound = requireParticipation(this.persistence.snapshot(), source);
      if (agent.catId !== source.catId || agent.agentId !== source.catId || !(await this.verifyAgent(agent)))
        throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Host could not verify the current Cat invocation');
      return bound;
    };
    const invoke = await this.withAuthority(source.connectionId, async () => {
      const { connection, credential } = await validate();
      const body = {
        ...input,
        serviceInstanceId: source.serviceInstanceId,
        collectiveId: source.collectiveId,
        connectionId: source.connectionId,
        catId: source.catId,
        participationRevision: source.participationRevision,
        requestEventId: source.eventId,
      };
      return () => this.service.artifacts.requestAgent(connection.serviceUrl, credential, body);
    });
    const value = await invoke();
    await this.withAuthority(source.connectionId, validate);
    return value;
  }

  setChannelListening(connectionId: string, ownerUserId: string, input: ChannelListeningInput) {
    return this.withAuthority(connectionId, () =>
      setChannelListening({
        persistence: this.persistence,
        now: this.now,
        connectionId,
        ownerUserId,
        unsafeInput: input,
      }),
    );
  }
  readWorkPolicy(connectionId: string) {
    return this.withAuthority(connectionId, () => this.workPolicy.read(connectionId));
  }
  readWorkPolicyStatus(connectionId: string) {
    return this.withAuthority(connectionId, () => this.workPolicy.status(connectionId));
  }
  currentWorkDecision(source: CollectiveSourceIdentity) {
    return this.withAuthority(source.connectionId, () => this.workPolicy.decision(source));
  }
  /** One local owner effect fence for a source that has not yet acquired private Work custody. */
  withWorkReconsiderationAuthority<T>(
    connectionId: string,
    ownerUserId: string,
    request: WorkReconsiderationInput,
    consume: (scope: WorkReconsiderationAuthorityScope) => Promise<T>,
  ) {
    return this.withAuthority(connectionId, async () =>
      consume(
        await prepareWorkReconsideration({
          persistence: this.persistence,
          policy: this.workPolicy,
          connectionId,
          ownerUserId,
          request,
          readContext: (source, before, limit) => this.readParticipationContext(source, before, limit),
        }),
      ),
    );
  }
  adoptWorkPolicy(connectionId: string, ownerUserId: string, expectedPolicyRevision: number) {
    return this.withAuthority(connectionId, () =>
      this.workPolicy.adopt(connectionId, ownerUserId, expectedPolicyRevision),
    );
  }
  revokeWorkGrants(connectionId: string, ownerUserId: string, grantRefs: string[]) {
    return this.withAuthority(connectionId, () => this.workPolicy.revoke(connectionId, ownerUserId, grantRefs));
  }
  acceptWork(source: CollectiveSourceIdentity, agent: VerifiedAgent, input: CollectiveWorkAcceptanceInput) {
    return this.withAuthority(source.connectionId, () => this.workAcceptance.accept(source, agent, input));
  }
  continueWork(source: CollectiveSourceIdentity, agent: VerifiedAgent, input: CollectiveWorkContinuationInput) {
    return this.withAuthority(source.connectionId, () => this.workContinuation.continue(source, agent, input));
  }
  readWorkSourceContext(source: CollectiveSourceIdentity) {
    return this.withAuthority(source.connectionId, async () => {
      const { connection, credential } = requireParticipation(this.persistence.snapshot(), source);
      await this.readParticipationContext(source, 0, 1);
      const context = await this.service.workAuthority.readSourceContext(connection.serviceUrl, credential, {
        ...workCoordinates(connection),
        sourceEventId: source.eventId,
        catId: source.catId,
        participationRevision: source.participationRevision,
      });
      requireParticipation(this.persistence.snapshot(), source);
      if (context.sourceEventId !== source.eventId) throw new Error('Collective matter source identity changed');
      return context;
    });
  }
  readWorkRoutingContext(connectionId: string, sourceEventId: string) {
    return this.withAuthority(connectionId, async () => {
      const snapshot = this.persistence.snapshot();
      const connection = requireConnection(snapshot.connections[connectionId]);
      const credential = requireCredential(connection);
      const route = snapshot.hostRoutes[connectionId];
      if (!route?.localOwnerUserId) throw new Error('Host owner routing relationship is unavailable');
      const context = await this.service.workAuthority.readRoutingContext(connection.serviceUrl, credential, {
        ...workCoordinates(connection),
        sourceEventId,
      });
      const after = this.persistence.snapshot();
      if (
        after.connections[connectionId]?.authorityStatus !== 'connected' ||
        after.connections[connectionId]?.endpointCredential !== credential ||
        after.hostRoutes[connectionId]?.localOwnerUserId !== route.localOwnerUserId ||
        context.sourceEventId !== sourceEventId
      )
        throw new Error('Current Work routing authority changed');
      return context;
    });
  }
  /** The enclosing consumer fence, when needed, belongs to withAssignedWorkAuthority. */
  resolveAcceptedWorkGrant(source: CollectiveSourceIdentity) {
    return this.workAcceptance.resolveGrant(source);
  }
  recordHostAdmission(
    connectionId: string,
    input: Omit<CollectiveWorkHostAdmissionRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    return this.withAuthority(connectionId, () => this.workAcceptance.recordHostAdmission(connectionId, input));
  }

  async revoke(connectionId: string): Promise<ConnectorProjection> {
    return this.withAuthority(connectionId, () => this.synchronization.revoke(connectionId));
  }

  async getProjection(connectionId: string): Promise<ConnectorProjection> {
    const snapshot = this.persistence.snapshot();
    return projectConnection(requireConnection(snapshot.connections[connectionId]), snapshot.hostRoutes[connectionId]);
  }

  async listConnections(): Promise<ConnectorProjection[]> {
    const snapshot = this.persistence.snapshot();
    return Object.values(snapshot.connections).map((connection) =>
      projectConnection(connection, snapshot.hostRoutes[connection.connectionId]),
    );
  }

  async readPendingAccountabilityRequests(
    connectionId: string,
    ownerUserId: string,
    page: { readonly offset: number; readonly limit: number; readonly snapshot?: string },
  ) {
    return this.withAuthority(connectionId, async () => {
      const before = this.persistence.snapshot();
      const connection = requireConnection(before.connections[connectionId]);
      const credential = requireCredential(connection);
      const route = before.hostRoutes[connectionId];
      if (!route || route.localOwnerUserId !== ownerUserId) {
        throw new Error('Host owner does not control this Collective connection');
      }
      if (!connection.authorizedHumanId) throw new Error('Collective connection has no authorized Human');
      const read = await this.service.readPendingAccountabilityRequests(connection.serviceUrl, credential, {
        serviceInstanceId: connection.serviceInstanceId,
        collectiveId: connection.collectiveId,
        connectionId: connection.connectionId,
        offset: page.offset,
        limit: page.limit,
        ...(page.snapshot ? { snapshot: page.snapshot } : {}),
      });
      const after = this.persistence.snapshot();
      const currentConnection = requireConnection(after.connections[connectionId]);
      const currentRoute = after.hostRoutes[connectionId];
      const authorityMatches =
        currentConnection.authorityStatus === 'connected' &&
        currentConnection.endpointCredential === credential &&
        currentConnection.serviceInstanceId === connection.serviceInstanceId &&
        currentConnection.collectiveId === connection.collectiveId &&
        currentConnection.authorizedHumanId === connection.authorizedHumanId &&
        currentRoute?.revision === route.revision &&
        currentRoute.localOwnerUserId === ownerUserId;
      const responseMatches =
        read.identity.serviceInstanceId === currentConnection.serviceInstanceId &&
        read.identity.collectiveId === currentConnection.collectiveId &&
        read.identity.connectionId === currentConnection.connectionId &&
        read.identity.authorizedHumanId === currentConnection.authorizedHumanId &&
        read.page.offset === page.offset &&
        read.page.limit === page.limit &&
        (!page.snapshot || read.page.snapshot === page.snapshot);
      if (!authorityMatches || !responseMatches) {
        throw new Error('Collective accountability authority changed while it was being read');
      }
      return read;
    });
  }

  async listInbox(connectionId: string) {
    const connection = requireConnection(this.persistence.snapshot().connections[connectionId]);
    return structuredClone(connection.inbox);
  }

  async listWorkResultPublicationCandidates(): Promise<CollectiveWorkResultPublicationCandidate[]> {
    const snapshot = this.persistence.snapshot();
    return Object.values(snapshot.connections).flatMap((connection) =>
      projectWorkResultPublications(connection, snapshot.hostRoutes[connection.connectionId]).map((publication) => ({
        connectionId: publication.connectionId,
        workId: publication.workId,
        taskRef: publication.taskRef,
      })),
    );
  }

  /** Backfills one immutable sidecar for a result accepted before file publication existed. */
  async reconcileAcceptedWorkResultFiles(
    connectionId: string,
    seal: (
      scope: AssignedWorkAuthorityScope,
      publication: CollectiveWorkResultPublication,
    ) => Promise<AcceptedWorkResultFileSeal | undefined>,
  ): Promise<{ readonly published: number }> {
    return this.withAuthority(connectionId, () =>
      reconcileAcceptedWorkResultFiles({
        connectionId,
        persistence: this.persistence,
        service: this.service,
        readScope: async (workId) =>
          this.assignedWorkAuthorityScope(
            connectionId,
            await this.readAssignedWorkWithinAuthority(connectionId, workId),
          ),
        seal,
      }),
    );
  }

  async setHostRoute(
    connectionId: string,
    unsafeInput: SetHostRouteInput,
    expectedRevision?: number,
  ): Promise<HostRouteConfig> {
    return this.withAuthority(connectionId, () =>
      setHostRoute({
        persistence: this.persistence,
        now: this.now,
        connectionId,
        unsafeInput,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    );
  }

  async setStandingInterest(
    connectionId: string,
    input: StandingInterestInput,
    expectedRevision: number,
  ): Promise<HostRouteConfig> {
    return this.withAuthority(connectionId, () =>
      setStandingInterest({
        persistence: this.persistence,
        now: this.now,
        connectionId,
        unsafeInput: input,
        expectedRevision,
      }),
    );
  }

  async publishParticipation(connectionId: string): Promise<void> {
    return this.withAuthority(connectionId, async () => {
      const state = this.persistence.snapshot();
      const connection = requireConnection(state.connections[connectionId]);
      const route = state.hostRoutes[connectionId];
      if (!route || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
        throw new Error('Participation is not configured');
      await this.service.publishParticipation(
        connection.serviceUrl,
        connection.endpointCredential,
        participationDeclaration(connection, route),
      );
    });
  }

  /** Linearizes accepted public effects with local binding changes and endpoint revocation. */
  private async withAuthority<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.authorityTails.get(connectionId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.authorityTails.set(connectionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.authorityTails.get(connectionId) === current) this.authorityTails.delete(connectionId);
    }
  }

  async isParticipationPublished(connectionId: string): Promise<boolean> {
    const state = this.persistence.snapshot();
    const connection = requireConnection(state.connections[connectionId]);
    const route = state.hostRoutes[connectionId];
    if (!route || connection.authorityStatus !== 'connected' || !connection.endpointCredential) return false;
    const declaration = await this.service.readParticipationDeclaration(
      connection.serviceUrl,
      connection.endpointCredential,
      {
        serviceInstanceId: connection.serviceInstanceId,
        collectiveId: connection.collectiveId,
        connectionId,
      },
    );
    return (
      isDeepStrictEqual(declaration, participationDeclaration(connection, route)) &&
      this.persistence.snapshot().hostRoutes[connectionId]?.revision === route.revision
    );
  }

  async readParticipationContext(source: CollectiveSourceIdentity, afterSequence = 0, limit = 30) {
    const { connection, credential } = requireParticipation(this.persistence.snapshot(), source);
    const context = await this.service.readParticipationContext(
      connection.serviceUrl,
      credential,
      source,
      afterSequence,
      limit,
    );
    requireParticipation(this.persistence.snapshot(), source);
    if (
      context.source.eventId !== source.eventId ||
      context.source.serviceInstanceId !== source.serviceInstanceId ||
      context.source.collectiveId !== source.collectiveId ||
      !isDeepStrictEqual(context.source.location, source.location) ||
      !isDeepStrictEqual(context.source.actor, source.actor)
    )
      throw new Error('Collective source identity changed');
    return context;
  }

  async readArtifactContext(source: CollectiveSourceIdentity) {
    const { connection, credential } = requireParticipation(this.persistence.snapshot(), source);
    let context: CollectiveArtifactAgentContext;
    try {
      context = await this.service.artifacts.readContext(connection.serviceUrl, credential, {
        serviceInstanceId: source.serviceInstanceId,
        collectiveId: source.collectiveId,
        connectionId: source.connectionId,
        eventId: source.eventId,
        catId: source.catId,
        participationRevision: source.participationRevision,
      });
    } catch (error) {
      if (!(error instanceof ConnectorTransportError) || error.statusCode !== 404 || error.code !== 'NOT_FOUND')
        throw error;
      // Older Services expose ordinary participation without this independent W4 capability.
      context = { status: 'unavailable' as const, requests: [] };
    }
    requireParticipation(this.persistence.snapshot(), source);
    return context;
  }

  prepareReply(
    source: CollectiveSourceIdentity,
    sourceRef: string,
    resultKey: string,
    workRevision?: number,
    resultRevision?: number,
    execution?: { readonly revision: number; readonly assignmentEventId: string },
  ) {
    return prepareReplyOperation({
      persistence: this.persistence,
      now: this.now,
      source,
      sourceRef,
      resultKey,
      ...(workRevision ? { workRevision } : {}),
      ...(resultRevision ? { resultRevision } : {}),
      ...(execution ? { execution } : {}),
    });
  }

  readPublicReply(source: CollectiveSourceIdentity, sourceRef: string) {
    return readPublicReplyOperation(this.persistence, source, sourceRef);
  }

  async submitReply(
    source: CollectiveSourceIdentity,
    sourceRef: string,
    resultKey: string,
    operationId: string,
    body: string,
    agent: VerifiedAgent,
    artifactSnapshot?: WorkResultArtifactSnapshot,
    resultRevision?: number,
    execution?: { readonly revision: number; readonly assignmentEventId: string },
    resultFileSource?: CollectiveWorkResultTextSource,
  ) {
    await this.readParticipationContext(source, 0, 1);
    const publishResultFile = resultFileSource && workResultBodyLinksTextSource(body, resultFileSource);
    if (publishResultFile) {
      const { connection } = requireParticipation(this.persistence.snapshot(), source);
      const metadata = await this.service.readMetadata(connection.serviceUrl);
      if (metadata.serviceInstanceId !== connection.serviceInstanceId)
        throw participationError('RETURN_UNAVAILABLE', 'Collective Service identity changed before result publication');
      if (metadata.capabilities?.workResultFiles !== 1)
        throw participationError(
          'RETURN_UNAVAILABLE',
          'Collective Service must support authenticated Work result files before this result can be published',
        );
    }
    return submitReplyOperation({
      persistence: this.persistence,
      now: this.now,
      source,
      sourceRef,
      resultKey,
      operationId,
      body,
      agent,
      ...(artifactSnapshot ? { artifactSnapshot } : {}),
      ...(resultRevision ? { resultRevision } : {}),
      verifyAgent: this.verifyAgent,
      ...(execution ? { execution } : {}),
      ...(publishResultFile ? { resultFileSource } : {}),
    });
  }

  prepareProgress(purpose: CollectiveProgressPurpose) {
    return prepareProgressOperation(this.persistence, this.now, purpose);
  }
  async submitProgress(purpose: CollectiveProgressPurpose, operationId: string, agent: VerifiedAgent) {
    await this.readParticipationContext(purpose.source, 0, 1);
    return submitProgressOperation({
      persistence: this.persistence,
      now: this.now,
      purpose,
      operationId,
      agent,
      verifyAgent: this.verifyAgent,
    });
  }

  async proposeWork(
    source: CollectiveSourceIdentity,
    requestId: string,
    agent: VerifiedAgent,
    input: {
      readonly title?: string;
      readonly intendedOutcome?: string;
      readonly requestKind?: string;
      readonly projectSuggestion?: CollectiveProjectWorkSuggestionTarget;
    } = {},
  ) {
    return this.withAuthority(source.connectionId, async () => {
      await this.readParticipationContext(source, 0, 1);
      return proposeVerifiedCollectiveWork({
        persistence: this.persistence,
        service: this.service,
        verifyAgent: this.verifyAgent,
        source,
        requestId,
        agent,
        proposal: input,
      });
    });
  }

  async readAssignedWork(connectionId: string, workId: string) {
    return this.withAuthority(connectionId, () => this.readAssignedWorkWithinAuthority(connectionId, workId));
  }
  async readAssignedWorkByAssignment(connectionId: string, assignmentEventId: string) {
    return this.withAuthority(connectionId, () =>
      this.readAssignedWorkByAssignmentWithinAuthority(connectionId, assignmentEventId),
    );
  }

  /** Keeps the endpoint credential, Host route, inbox source, and caller-owned
   * effect under the same connection fence as revoke/rebind. The consumer may
   * mutate only its own owner; Connector state remains private to this scope.
   */
  async withAssignedWorkAuthority<T>(
    connectionId: string,
    workId: string,
    consume: (scope: AssignedWorkAuthorityScope) => Promise<T>,
  ): Promise<T> {
    return this.withAuthority(connectionId, async () => {
      const work = await this.readAssignedWorkWithinAuthority(connectionId, workId);
      return consume(this.assignedWorkAuthorityScope(connectionId, work));
    });
  }

  /** Pulls the latest endpoint events and resolves the Service Work from the
   * immutable assignment event before admitting a local continuation.
   */
  async withSynchronizedAssignedWorkAuthority<T>(
    connectionId: string,
    assignmentEventId: string,
    consume: (scope: AssignedWorkAuthorityScope) => Promise<T>,
  ): Promise<T> {
    return this.withAuthority(connectionId, async () => {
      await this.synchronization.sync(connectionId);
      const work = await this.readAssignedWorkByAssignmentWithinAuthority(connectionId, assignmentEventId);
      return consume(this.assignedWorkAuthorityScope(connectionId, work));
    });
  }

  async getHostRoute(connectionId: string): Promise<HostRouteConfig | undefined> {
    return getHostRoute(this.persistence, connectionId);
  }

  async listInboxForRouting(connectionId: string): Promise<ConnectorInboxItem[]> {
    return listInboxForRouting(this.persistence, connectionId);
  }

  async beginInboxRouting(
    connectionId: string,
    eventId: string,
    routeConfigRevision: number,
  ): Promise<ConnectorInboxItem> {
    return beginInboxRouting({
      persistence: this.persistence,
      now: this.now,
      connectionId,
      eventId,
      routeConfigRevision,
    });
  }

  async completeInboxRouting(
    connectionId: string,
    eventId: string,
    routeConfigRevision: number,
    receipt: ConnectorRouteReceipt,
  ): Promise<ConnectorInboxItem> {
    return completeInboxRouting({
      persistence: this.persistence,
      now: this.now,
      connectionId,
      eventId,
      routeConfigRevision,
      receipt,
    });
  }

  async failInboxRouting(
    connectionId: string,
    eventId: string,
    routeConfigRevision: number,
    failure: ConnectorRouteFailure,
  ): Promise<ConnectorInboxItem> {
    return failInboxRouting({
      persistence: this.persistence,
      connectionId,
      eventId,
      routeConfigRevision,
      failure,
    });
  }

  private async readAssignedWorkWithinAuthority(
    connectionId: string,
    workId: string,
  ): Promise<CollectiveWorkProjection> {
    const before = requireConnection(this.persistence.snapshot().connections[connectionId]);
    const credential = requireCredential(before);
    const work = await this.service.readAssignedWork(before.serviceUrl, credential, {
      serviceInstanceId: before.serviceInstanceId,
      collectiveId: before.collectiveId,
      connectionId: before.connectionId,
      workId,
    });
    const after = requireConnection(this.persistence.snapshot().connections[connectionId]);
    if (
      after.authorityStatus !== 'connected' ||
      after.endpointCredential !== credential ||
      work.serviceInstanceId !== after.serviceInstanceId ||
      work.collectiveId !== after.collectiveId ||
      work.assignment?.connectionId !== after.connectionId
    ) {
      throw new Error('Assigned Work authority changed while it was being read');
    }
    return work;
  }

  private async readAssignedWorkByAssignmentWithinAuthority(
    connectionId: string,
    assignmentEventId: string,
  ): Promise<CollectiveWorkProjection> {
    const before = requireConnection(this.persistence.snapshot().connections[connectionId]);
    const credential = requireCredential(before);
    const work = await this.service.readAssignedWorkByAssignment(before.serviceUrl, credential, {
      serviceInstanceId: before.serviceInstanceId,
      collectiveId: before.collectiveId,
      connectionId: before.connectionId,
      assignmentEventId,
    });
    const after = requireConnection(this.persistence.snapshot().connections[connectionId]);
    if (
      after.authorityStatus !== 'connected' ||
      after.endpointCredential !== credential ||
      work.serviceInstanceId !== after.serviceInstanceId ||
      work.collectiveId !== after.collectiveId ||
      work.assignmentEventId !== assignmentEventId ||
      work.assignment?.connectionId !== after.connectionId
    ) {
      throw new Error('Assigned Work authority changed while it was being read');
    }
    return work;
  }

  private assignedWorkAuthorityScope(connectionId: string, work: CollectiveWorkProjection): AssignedWorkAuthorityScope {
    const snapshot = this.persistence.snapshot();
    const connection = requireConnection(snapshot.connections[connectionId]);
    const hostRoute = snapshot.hostRoutes[connectionId];
    return {
      connection: projectConnection(connection, hostRoute),
      ...(hostRoute ? { hostRoute: structuredClone(hostRoute) } : {}),
      inbox: structuredClone(connection.inbox),
      work,
      resultPublications: projectWorkResultPublications(connection, hostRoute, work.workId),
      recordHostAdmission: (input) => this.workAcceptance.recordHostAdmission(connectionId, input),
    };
  }
}

function requireConnection<Connection extends ConnectorConnectionState>(
  connection: Connection | undefined,
): Connection {
  if (!connection) throw new Error('Collective connection was not found');
  return connection;
}

function requireCredential(connection: ConnectorConnectionState): string {
  if (connection.authorityStatus !== 'connected' || !connection.endpointCredential) {
    throw new Error('Collective endpoint credential is unavailable');
  }
  return connection.endpointCredential;
}
