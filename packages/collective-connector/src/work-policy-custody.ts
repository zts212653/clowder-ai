import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CollectiveSourceIdentity } from '@cat-cafe/shared';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { ConnectorConnectionState } from './state.js';
import type { CollectiveWorkAuthorityClient } from './work-authority-client.js';
import { emptyWorkCustody } from './work-custody-state.js';
import { flushWorkRevocations } from './work-revocation-recovery.js';

/** Local owner adoption consumes only the registered Service revision, never a caller descriptor. */
export class ConnectorWorkPolicyCustody {
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveWorkAuthorityClient,
    private readonly now: () => number,
  ) {}

  async read(connectionId: string) {
    const connection = this.connection(connectionId);
    return this.service.readPolicy(connection.serviceUrl, connection.endpointCredential, workCoordinates(connection));
  }
  async status(connectionId: string) {
    const connection = this.connection(connectionId);
    const policy = await this.read(connectionId);
    const custody = connection.workCustody;
    const adopted = custody?.adoptedPolicy;
    const grants = (adopted?.grants ?? []).map((grant) => {
      const current = policy?.grants.find((candidate) => candidate.grantRef === grant.grantRef);
      const state =
        custody?.blockedGrantRefs.includes(grant.grantRef) || grant.status === 'revoked'
          ? ('blocked' as const)
          : grant.expiresAt !== null && Date.parse(grant.expiresAt) <= this.now()
            ? ('expired' as const)
            : !current || !isDeepStrictEqual(grant, current)
              ? ('changed' as const)
              : ('active' as const);
      return {
        grantRef: grant.grantRef,
        grantRevision: grant.grantRevision,
        state,
        decisionMode: grant.decisionMode ?? adopted?.decisionMode,
      };
    });
    return {
      policy,
      localAdoption: adopted
        ? {
            revision: adopted.revision,
            adoptedAt: custody?.adoptedAt,
            decisionMode:
              adopted.decisionMode === 'manual' || policy?.decisionMode === 'manual'
                ? ('manual' as const)
                : ('automatic' as const),
            pendingRevocations:
              custody?.revocations
                .filter((operation) => operation.status === 'pending')
                .map((operation) => operation.requestId) ?? [],
            grants,
          }
        : null,
    };
  }
  async decision(source: CollectiveSourceIdentity) {
    const { connection } = requireParticipation(this.persistence.snapshot(), source);
    const remote = await this.read(source.connectionId);
    const local = connection.workCustody?.adoptedPolicy;
    const requester = source.actor.kind === 'human' ? source.actor.humanId : source.actor.human.humanId;
    const grants = (local?.grants ?? []).filter(
      (grant) =>
        grant.status === 'active' &&
        !connection.workCustody?.blockedGrantRefs.includes(grant.grantRef) &&
        isDeepStrictEqual(
          grant,
          remote?.grants.find((candidate) => candidate.grantRef === grant.grantRef),
        ) &&
        grant.catIds.includes(source.catId) &&
        grant.channelIds.includes(source.location.channelId) &&
        (grant.requestingHumanIds === 'channel_members' || grant.requestingHumanIds.includes(requester)) &&
        (!grant.sourceEventIds || grant.sourceEventIds.includes(source.eventId)) &&
        (grant.expiresAt === null || Date.parse(grant.expiresAt) > this.now()),
    );
    return {
      decisionMode:
        local?.decisionMode === 'manual' || remote?.decisionMode === 'manual'
          ? ('manual' as const)
          : ('automatic' as const),
      delegationState: local && remote ? ('adopted' as const) : ('unavailable' as const),
      grants: grants.map((grant) => ({
        grantRef: grant.grantRef,
        grantRevision: grant.grantRevision,
        requestKinds: grant.requestKinds,
        expiresAt: grant.expiresAt,
        allowedOnce: Boolean(grant.sourceEventIds?.includes(source.eventId)),
        decisionMode: grant.decisionMode ?? remote?.decisionMode ?? local?.decisionMode ?? 'manual',
      })),
    };
  }

  async adopt(connectionId: string, ownerUserId: string, expectedPolicyRevision: number) {
    const connection = this.ownerConnection(connectionId, ownerUserId);
    const policy = await this.read(connectionId);
    if (!policy || policy.revision !== expectedPolicyRevision || policy.ownerHumanId !== connection.authorizedHumanId)
      throw participationError('WORK_POLICY_REVISION_CONFLICT', 'Adopt the exact current registered owner policy');
    await this.persistence.transaction((state) => {
      const current = state.connections[connectionId];
      current.workCustody ??= emptyWorkCustody();
      const custody = current.workCustody;
      if (custody.revocations.some((operation) => operation.status === 'pending'))
        throw participationError(
          'WORK_REVOCATION_PENDING',
          'Confirm pending revocation before adopting another version',
        );
      if (custody.adoptedPolicy && policy.revision < custody.adoptedPolicy.revision)
        throw participationError('WORK_POLICY_REVISION_CONFLICT', 'Owner policy cannot move backwards');
      custody.blockedGrantRefs = custody.blockedGrantRefs.filter((ref) => {
        const previous = custody.adoptedPolicy?.grants.find((grant) => grant.grantRef === ref);
        const next = policy.grants.find((grant) => grant.grantRef === ref);
        return !next || next.status !== 'active' || next.grantRevision <= (previous?.grantRevision ?? 0);
      });
      custody.adoptedPolicy = policy;
      custody.adoptedAt = new Date(this.now()).toISOString();
    });
    return policy;
  }

  async revoke(connectionId: string, ownerUserId: string, grantRefs: string[]) {
    const connection = this.ownerConnection(connectionId, ownerUserId);
    const adopted = connection.workCustody?.adoptedPolicy;
    if (
      !grantRefs.length ||
      !adopted ||
      grantRefs.some((ref) => !adopted.grants.some((grant) => grant.grantRef === ref))
    )
      throw unavailable();
    // Persist contraction before network IO; an offline endpoint cannot continue under the old local permission.
    await this.persistence.transaction((state) => {
      state.connections[connectionId].workCustody ??= emptyWorkCustody();
      const custody = state.connections[connectionId].workCustody;
      custody.blockedGrantRefs = [...new Set([...custody.blockedGrantRefs, ...grantRefs])];
      const refs = [...new Set(grantRefs)].sort();
      if (
        !custody.revocations.some(
          (operation) => operation.status === 'pending' && isDeepStrictEqual(operation.grantRefs, refs),
        )
      )
        custody.revocations.push({
          requestId: `host-revoke:${randomUUID()}`,
          expectedRevision: adopted.revision,
          grantRefs: refs,
          targets: adopted.grants
            .filter((grant) => refs.includes(grant.grantRef))
            .map(({ grantRef, grantRevision }) => ({ grantRef, grantRevision })),
          status: 'pending',
        });
    });
    await this.flushRevocations(connectionId);
  }

  async flushRevocations(connectionId: string, recoverConflicts = false) {
    await flushWorkRevocations(this.persistence, this.service, this.connection(connectionId), recoverConflicts);
  }

  async requireGrant(
    source: CollectiveSourceIdentity,
    grantRef: string,
    grantRevision: number,
    requestKind: string,
    admission = true,
  ) {
    const remote = await this.read(source.connectionId);
    const { connection } = requireParticipation(this.persistence.snapshot(), source);
    const custody = connection.workCustody;
    const local = custody?.adoptedPolicy;
    const grant = local?.grants.find((candidate) => candidate.grantRef === grantRef);
    const registered = remote?.grants.find((candidate) => candidate.grantRef === grantRef);
    const requester = source.actor.kind === 'human' ? source.actor.humanId : source.actor.human.humanId;
    if (
      !grant ||
      !remote ||
      !local ||
      local.ownerHumanId !== connection.authorizedHumanId ||
      remote.ownerHumanId !== local.ownerHumanId ||
      custody?.blockedGrantRefs.includes(grantRef) ||
      !isDeepStrictEqual(grant, registered) ||
      grant.status !== 'active' ||
      grant.grantRevision !== grantRevision ||
      !grant.catIds.includes(source.catId) ||
      !grant.channelIds.includes(source.location.channelId) ||
      !grant.requestKinds.includes(requestKind) ||
      (grant.requestingHumanIds !== 'channel_members' && !grant.requestingHumanIds.includes(requester)) ||
      (grant.sourceEventIds && !grant.sourceEventIds.includes(source.eventId)) ||
      (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= this.now())
    )
      throw unavailable();
    if (
      admission &&
      ((grant.decisionMode ?? local.decisionMode) === 'manual' ||
        (registered?.decisionMode ?? remote.decisionMode) === 'manual') &&
      !grant.sourceEventIds?.includes(source.eventId)
    )
      throw participationError('WORK_OWNER_DECISION_REQUIRED', 'The owner must decide this exact request');
    return grant;
  }

  private ownerConnection(connectionId: string, ownerUserId: string) {
    if (this.persistence.snapshot().hostRoutes[connectionId]?.localOwnerUserId !== ownerUserId)
      throw participationError('CONNECTOR_OWNER_MISMATCH', 'Only this local owner can adopt or withdraw delegation');
    return this.connection(connectionId);
  }
  private connection(connectionId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw unavailable();
    return { ...connection, endpointCredential: connection.endpointCredential };
  }
}

export const workCoordinates = (connection: ConnectorConnectionState) => ({
  serviceInstanceId: connection.serviceInstanceId,
  collectiveId: connection.collectiveId,
  connectionId: connection.connectionId,
});
export function unavailable() {
  return participationError(
    'WORK_DELEGATION_UNAVAILABLE',
    'Current registered and locally adopted delegation does not cover this operation',
  );
}
