import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveSourceIdentity,
  type CollectiveWorkHostAdmissionRequest,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
} from '@cat-cafe/shared';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { CollectiveServiceClient } from './service-client.js';
import { ConnectorTransportError } from './service-client.js';
import type { VerifiedAgent } from './state.js';
import { emptyWorkCustody } from './work-custody-state.js';
import { hostAdmissionRequestMatches, prepareHostAdmission } from './work-host-admission-custody.js';
import { ConnectorWorkPolicyCustody, unavailable, workCoordinates } from './work-policy-custody.js';

export interface CollectiveWorkAcceptanceInput {
  readonly grantRef: string;
  readonly grantRevision: number;
  readonly requestKind: string;
  readonly title: string;
  readonly intendedOutcome: string;
}

/** Durable operations cross boundaries; they are not another Work or Task ledger. */
export class ConnectorWorkAcceptanceCustody {
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
    private readonly policy: ConnectorWorkPolicyCustody,
    private readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>,
    private readonly now: () => number,
  ) {}

  async resolveGrant(source: CollectiveSourceIdentity) {
    const { connection, credential } = requireParticipation(this.persistence.snapshot(), source);
    const context = await this.service.readParticipationContext(connection.serviceUrl, credential, source, 0, 1);
    const notice = context.source.workExecutionNotice;
    const work = notice
      ? await this.service.readAssignedWork(connection.serviceUrl, credential, {
          ...workCoordinates(connection),
          workId: notice.workId,
        })
      : await this.service.readAssignedWorkByAssignment(connection.serviceUrl, credential, {
          ...workCoordinates(connection),
          assignmentEventId: source.eventId,
        });
    const current = work.executionAuthority ?? work.acceptance;
    if (
      !current ||
      !isDeepStrictEqual(source.actor, context.source.actor) ||
      (notice
        ? !collectiveWorkExecutionMatches(source, work, notice)
        : !collectiveWorkAssignmentMatches(source, work, context.source.workAcceptanceNotice) ||
          (work.executionAuthority?.revision ?? 1) !== 1)
    )
      throw participationError('WORK_EXECUTION_NOT_CURRENT', 'Service has no exact current execution for this source');
    const originalContext = await this.service.readParticipationContext(
      connection.serviceUrl,
      credential,
      { ...source, eventId: current.sourceEventId },
      0,
      1,
    );
    const original = originalContext.source;
    if (!original.location) throw unavailable();
    const originalSource = { ...source, eventId: original.eventId, location: original.location, actor: original.actor };
    const grant = await this.policy.requireGrant(
      originalSource,
      current.grantRef,
      current.grantRevision,
      current.requestKind,
      false,
    );
    return { work, grant, originalSource };
  }

  async accept(source: CollectiveSourceIdentity, agent: VerifiedAgent, input: CollectiveWorkAcceptanceInput) {
    const { connection, binding } = requireParticipation(this.persistence.snapshot(), source);
    if (
      agent.catId !== source.catId ||
      agent.agentId !== source.catId ||
      agent.displayName !== binding.displayName ||
      !(await this.verifyAgent(agent))
    )
      throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Only the current real Cat can accept this request');
    await this.policy.requireGrant(source, input.grantRef, input.grantRevision, input.requestKind);
    // Preserve the old durable operation for exact-purpose recovery; a new real permission version is a new purpose.
    const previous = connection.workCustody?.acceptances.find(
      (operation) =>
        operation.source.eventId === source.eventId &&
        operation.source.catId === source.catId &&
        operation.request.grantRef === input.grantRef &&
        operation.request.grantRevision === input.grantRevision &&
        operation.request.requestKind === input.requestKind,
    );
    const requestId =
      previous?.request.requestId ??
      `cat-accept:${createHash('sha256')
        .update(
          JSON.stringify([
            source.serviceInstanceId,
            source.collectiveId,
            source.connectionId,
            source.eventId,
            source.catId,
            input.grantRef,
            input.grantRevision,
            input.requestKind,
          ]),
        )
        .digest('hex')}`;
    await this.persistence.transaction((state) => {
      const target = state.connections[source.connectionId];
      target.workCustody ??= emptyWorkCustody();
      const custody = target.workCustody;
      const existing = custody.acceptances.find((operation) => operation.request.requestId === requestId);
      if (existing) {
        const request = existing.request;
        if (
          request.title !== input.title ||
          request.intendedOutcome !== input.intendedOutcome ||
          request.requestKind !== input.requestKind ||
          request.grantRef !== input.grantRef ||
          request.grantRevision !== input.grantRevision
        )
          throw participationError(
            'COLLABORATION_OPERATION_CONFLICT',
            'This exact source already names a different acceptance operation',
          );
        return;
      }
      custody.acceptances.push({
        source,
        request: {
          ...workCoordinates(connection),
          sourceEventId: source.eventId,
          requestId,
          catId: source.catId,
          participationRevision: source.participationRevision,
          sessionRef: agent.sessionRef,
          ...input,
        },
        status: 'prepared',
        createdAt: new Date(this.now()).toISOString(),
      });
    });
    return this.submit(source.connectionId, requestId);
  }

  async recover(connectionId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    for (const operation of connection?.workCustody?.acceptances ?? []) {
      if (operation.status !== 'prepared') continue;
      try {
        await this.submit(connectionId, operation.request.requestId);
      } catch (error) {
        if (!isAcceptanceRefusal(error)) throw error;
        // Rejected current permission is durable; another operation remains independently recoverable.
      }
    }
    await this.flushHostAdmissions(connectionId);
  }

  async recordHostAdmission(
    connectionId: string,
    input: Omit<CollectiveWorkHostAdmissionRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    const connection = this.persistence.snapshot().connections[connectionId];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw unavailable();
    const request = { ...workCoordinates(connection), ...input };
    await this.persistence.transaction((state) => {
      const target = state.connections[connectionId];
      target.workCustody ??= emptyWorkCustody();
      prepareHostAdmission(target.workCustody, request);
    });
    await this.flushHostAdmissions(connectionId);
  }

  private async flushHostAdmissions(connectionId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    if (!connection?.endpointCredential || connection.authorityStatus !== 'connected') return;
    for (const operation of connection.workCustody?.hostAdmissions ?? []) {
      if (operation.status !== 'pending') continue;
      let failureCode: string | undefined;
      try {
        await this.service.workAuthority.recordHostAdmission(
          connection.serviceUrl,
          connection.endpointCredential,
          operation.request,
        );
      } catch (error) {
        const code = workErrorCode(error);
        if (
          !code ||
          ![
            'WORK_ADMISSION_NOT_CURRENT',
            'WORK_DELEGATION_UNAVAILABLE',
            'PARTICIPATION_REVOKED',
            'CONNECTION_REVOKED',
          ].includes(code)
        )
          throw error;
        failureCode = code;
      }
      await this.persistence.transaction((state) => {
        const current = state.connections[connectionId].workCustody?.hostAdmissions.find((item) =>
          hostAdmissionRequestMatches(item.request, operation.request),
        );
        if (current) {
          current.status = failureCode ? 'blocked' : 'confirmed';
          if (failureCode) current.failureCode = failureCode;
        }
      });
    }
  }

  private async submit(connectionId: string, requestId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    const operation = connection?.workCustody?.acceptances.find((item) => item.request.requestId === requestId);
    if (
      !operation ||
      !connection.endpointCredential ||
      connection.authorityStatus !== 'connected' ||
      operation.status === 'blocked'
    )
      throw unavailable();
    try {
      const request = operation.request;
      await this.policy.requireGrant(operation.source, request.grantRef, request.grantRevision, request.requestKind);
      const work = await this.service.workAuthority.acceptWork(
        connection.serviceUrl,
        connection.endpointCredential,
        request,
      );
      if (
        !work.assignmentEventId ||
        !work.acceptance ||
        work.acceptance.operationRef !== requestId ||
        work.assignment?.connectionId !== connectionId ||
        work.assignment.catId !== operation.source.catId
      )
        throw participationError('WORK_ADMISSION_NOT_CURRENT', 'Service response does not cover this exact acceptance');
      await this.persistence.transaction((state) => {
        const current = state.connections[connectionId].workCustody?.acceptances.find(
          (item) => item.request.requestId === requestId,
        );
        if (current) {
          current.status = 'accepted';
          current.workId = work.workId;
          current.assignmentEventId = work.assignmentEventId;
        }
      });
      return work;
    } catch (error) {
      const code = isAcceptanceRefusal(error) ? workErrorCode(error) : undefined;
      if (code)
        await this.persistence.transaction((state) => {
          const current = state.connections[connectionId].workCustody?.acceptances.find(
            (item) => item.request.requestId === requestId,
          );
          if (current) {
            current.status = 'blocked';
            current.failureCode = code;
          }
        });
      throw error;
    }
  }
}

function workErrorCode(error: unknown): string | undefined {
  if (error instanceof ConnectorTransportError) return error.causeCode;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
function isAcceptanceRefusal(error: unknown) {
  return [
    'WORK_DELEGATION_UNAVAILABLE',
    'WORK_OWNER_DECISION_REQUIRED',
    'PARTICIPATION_REVOKED',
    'CONNECTION_REVOKED',
    'WORK_CONTINUATION_REQUIRED',
    'WORK_SOURCE_AMBIGUOUS',
    'COLLABORATION_OPERATION_CONFLICT',
  ].includes(workErrorCode(error) ?? '');
}
