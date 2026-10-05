import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveEventEnvelope,
  type CollectiveRegisteredWorkGrant,
  type CollectiveWorkGrantScope,
  type CollectiveWorkPolicy,
  collectiveConnectionCoordinatesSchema,
  collectiveRegisterWorkPolicyRequestSchema,
  collectiveRevokeWorkPolicyRequestSchema,
} from '@cat-cafe/shared';
import { requireHumanCommand } from './collaboration-command-helpers.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './identity-store.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

/** Stores the registered projection on the existing connection participation owner. */
export class CollectiveWorkPolicyStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async register(sessionToken: string, unsafeInput: unknown) {
    const input = collectiveRegisterWorkPolicyRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      const connection = state.connections[input.connectionId];
      if (
        !connection ||
        connection.status !== 'connected' ||
        connection.collectiveId !== input.collectiveId ||
        connection.authorizedHumanId !== human.humanId
      )
        throw new CollectiveServiceError(
          'WORK_DELEGATION_OWNER_REQUIRED',
          'Only the bound Human can register this delegation',
          403,
        );
      const participation = state.participations[input.connectionId];
      if (!participation) throw unavailable();
      const current = participation.workPolicy;
      const fingerprint = operationFingerprint(input);
      if (current && policyReplay(current, input.requestId, fingerprint)) return structuredClone(current);
      requirePolicyRevision(current, input.expectedRevision);
      const grants = registeredGrants(input.grants, current, input.decisionMode);
      const revision = (current?.revision ?? 0) + 1;
      const policy: CollectiveWorkPolicy = {
        revision,
        ownerHumanId: human.humanId,
        decisionMode: input.decisionMode,
        grants,
        history: [
          ...(current?.history ?? []),
          {
            requestId: input.requestId,
            fingerprint,
            revision,
            actor: 'human_owner',
            at: new Date(this.now()).toISOString(),
          },
        ],
      };
      participation.workPolicy = policy;
      return structuredClone(policy);
    });
  }

  read(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveConnectionCoordinatesSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, endpointCredential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    return { policy: structuredClone(state.participations[input.connectionId]?.workPolicy ?? null) };
  }

  readOwner(sessionToken: string, unsafeInput: unknown) {
    const input = collectiveConnectionCoordinatesSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const human = requireHumanCommand(state, sessionToken, input);
    const connection = state.connections[input.connectionId];
    if (
      !connection ||
      connection.status !== 'connected' ||
      connection.collectiveId !== input.collectiveId ||
      connection.authorizedHumanId !== human.humanId
    )
      throw new CollectiveServiceError(
        'WORK_DELEGATION_OWNER_REQUIRED',
        'Only the bound Human can read this delegation',
        403,
      );
    return { policy: structuredClone(state.participations[input.connectionId]?.workPolicy ?? null) };
  }

  /** A Host credential can contract authority, never issue or widen it. */
  async revoke(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveRevokeWorkPolicyRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, endpointCredential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const human = requireAuthorizedHuman(state, connection);
      const current = state.participations[input.connectionId]?.workPolicy;
      if (!current || current.ownerHumanId !== human.humanId) throw unavailable();
      const fingerprint = operationFingerprint(input);
      if (policyReplay(current, input.requestId, fingerprint)) return structuredClone(current);
      requirePolicyRevision(current, input.expectedRevision);
      if (input.grantRefs.some((ref) => !current.grants.some((grant) => grant.grantRef === ref))) throw unavailable();
      current.grants = current.grants.map((grant) =>
        input.grantRefs.includes(grant.grantRef)
          ? { ...grant, status: 'revoked', grantRevision: grant.grantRevision + Number(grant.status === 'active') }
          : grant,
      );
      current.revision++;
      current.history.push({
        requestId: input.requestId,
        fingerprint,
        revision: current.revision,
        actor: 'host_revocation',
        at: new Date(this.now()).toISOString(),
      });
      return structuredClone(current);
    });
  }
}

export function requireRegisteredWorkGrant(
  state: ServiceState,
  input: {
    connectionId: string;
    catId: string;
    grantRef: string;
    grantRevision: number;
    requestKind: string;
  },
  source: CollectiveEventEnvelope & { location: NonNullable<CollectiveEventEnvelope['location']> },
  now: number,
  admission = true,
) {
  const connection = state.connections[input.connectionId];
  const policy = state.participations[input.connectionId]?.workPolicy;
  const grant = policy?.grants.find((candidate) => candidate.grantRef === input.grantRef);
  const requestingHumanId = source.actor.kind === 'human' ? source.actor.humanId : source.actor.human.humanId;
  requireMembership(state, source.collectiveId, requestingHumanId);
  if (
    !policy ||
    policy.ownerHumanId !== connection?.authorizedHumanId ||
    !grant ||
    grant.status !== 'active' ||
    grant.grantRevision !== input.grantRevision ||
    !grant.catIds.includes(input.catId) ||
    !grant.channelIds.includes(source.location.channelId) ||
    !grant.requestKinds.includes(input.requestKind) ||
    (grant.requestingHumanIds !== 'channel_members' && !grant.requestingHumanIds.includes(requestingHumanId)) ||
    (grant.sourceEventIds && !grant.sourceEventIds.includes(source.eventId)) ||
    (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now)
  )
    throw unavailable();
  if (
    admission &&
    (grant.decisionMode ?? policy.decisionMode) === 'manual' &&
    !grant.sourceEventIds?.includes(source.eventId)
  )
    throw new CollectiveServiceError('WORK_OWNER_DECISION_REQUIRED', 'This request needs the owner decision', 409);
  return grant;
}

function omitGrantState(grant: CollectiveRegisteredWorkGrant) {
  const { grantRevision: _revision, status: _status, ...scope } = grant;
  return scope;
}
function registeredGrants(
  scopes: CollectiveWorkGrantScope[],
  current: CollectiveWorkPolicy | undefined,
  decisionMode: CollectiveWorkPolicy['decisionMode'],
): CollectiveRegisteredWorkGrant[] {
  const desired: CollectiveRegisteredWorkGrant[] = scopes.map((scope) => {
    const prior = current?.grants.find((grant) => grant.grantRef === scope.grantRef);
    return {
      ...scope,
      status: 'active',
      grantRevision:
        prior?.status === 'active' &&
        isDeepStrictEqual(omitGrantState(prior), scope) &&
        (prior.decisionMode ?? current?.decisionMode) === (scope.decisionMode ?? decisionMode)
          ? prior.grantRevision
          : (prior?.grantRevision ?? 0) + 1,
    };
  });
  const removed = (current?.grants ?? [])
    .filter((prior) => !scopes.some((scope) => scope.grantRef === prior.grantRef))
    .map((prior) => ({
      ...prior,
      status: 'revoked' as const,
      grantRevision: prior.grantRevision + Number(prior.status === 'active'),
    }));
  return [...desired, ...removed];
}
function operationFingerprint(input: unknown) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function policyReplay(policy: CollectiveWorkPolicy | undefined, requestId: string, fingerprint: string) {
  const previous = policy?.history.find((entry) => entry.requestId === requestId);
  if (!previous) return false;
  if (previous.fingerprint !== fingerprint)
    throw new CollectiveServiceError(
      'COLLABORATION_OPERATION_CONFLICT',
      'Owner operation already names different scope',
      409,
    );
  return true;
}
function requirePolicyRevision(policy: CollectiveWorkPolicy | undefined, expected: number) {
  if ((policy?.revision ?? 0) !== expected)
    throw new CollectiveServiceError('WORK_POLICY_REVISION_CONFLICT', 'Current owner policy changed', 409);
}
function unavailable() {
  return new CollectiveServiceError(
    'WORK_DELEGATION_UNAVAILABLE',
    'Current owner delegation does not cover this operation',
    403,
  );
}
