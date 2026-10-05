import { createHash } from 'node:crypto';
import type { CollectiveContinueWorkRequest, CollectiveSourceIdentity } from '@cat-cafe/shared';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import { type CollectiveServiceClient, ConnectorTransportError } from './service-client.js';
import type { VerifiedAgent } from './state.js';
import { emptyWorkCustody } from './work-custody-state.js';
import { type ConnectorWorkPolicyCustody, unavailable, workCoordinates } from './work-policy-custody.js';

export type CollectiveWorkContinuationInput = Pick<
  CollectiveContinueWorkRequest,
  | 'workId'
  | 'expectedRevision'
  | 'kind'
  | 'grantRef'
  | 'grantRevision'
  | 'requestKind'
  | 'resultEventId'
  | 'resultRevision'
>;

/** New valid continuation and retry have distinct permission/source coordinates, never a rerolled request ID. */
export class ConnectorWorkContinuationCustody {
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
    private readonly policy: ConnectorWorkPolicyCustody,
    private readonly verifyAgent: (agent: VerifiedAgent) => Promise<boolean>,
    private readonly now: () => number,
  ) {}

  async continue(source: CollectiveSourceIdentity, agent: VerifiedAgent, input: CollectiveWorkContinuationInput) {
    const { connection, binding } = requireParticipation(this.persistence.snapshot(), source);
    if (
      agent.catId !== source.catId ||
      agent.agentId !== source.catId ||
      agent.displayName !== binding.displayName ||
      !(await this.verifyAgent(agent))
    )
      throw participationError('AGENT_PROVENANCE_UNVERIFIED', 'Only the current real Cat can continue this matter');
    await this.policy.requireGrant(source, input.grantRef, input.grantRevision, input.requestKind);
    const requestId = `cat-continue:${createHash('sha256')
      .update(
        JSON.stringify([
          source.serviceInstanceId,
          source.collectiveId,
          source.connectionId,
          source.eventId,
          source.catId,
          input.workId,
          input.grantRef,
          input.grantRevision,
        ]),
      )
      .digest('hex')}`;
    await this.persistence.transaction((state) => {
      const connectionState = state.connections[source.connectionId];
      connectionState.workCustody ??= emptyWorkCustody();
      const existing = connectionState.workCustody.continuations.find((item) => item.request.requestId === requestId);
      if (existing) {
        if (existing.request.kind !== input.kind || existing.request.requestKind !== input.requestKind)
          throw participationError(
            'COLLABORATION_OPERATION_CONFLICT',
            'Recover the existing continuation for this source and permission',
          );
        return;
      }
      connectionState.workCustody.continuations.push({
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
    const operations = this.persistence.snapshot().connections[connectionId]?.workCustody?.continuations ?? [];
    for (const operation of operations) {
      if (operation.status !== 'prepared') continue;
      try {
        await this.submit(connectionId, operation.request.requestId);
      } catch (error) {
        if (!refusalCode(error)) throw error;
      }
    }
  }

  private async submit(connectionId: string, requestId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    const operation = connection?.workCustody?.continuations.find((item) => item.request.requestId === requestId);
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
      const work = await this.service.workAuthority.continueWork(
        connection.serviceUrl,
        connection.endpointCredential,
        request,
      );
      if (
        work.workId !== request.workId ||
        work.assignment?.connectionId !== connectionId ||
        work.assignment.catId !== request.catId ||
        work.executionAuthority?.operationRef !== requestId
      )
        throw participationError(
          'WORK_EXECUTION_NOT_CURRENT',
          'The Service continuation response does not cover this exact operation',
        );
      await this.persistence.transaction((state) => {
        const current = state.connections[connectionId].workCustody?.continuations.find(
          (item) => item.request.requestId === requestId,
        );
        if (current) {
          current.status = 'accepted';
          current.executionRevision = work.executionAuthority?.revision;
        }
      });
      return work;
    } catch (error) {
      const code = refusalCode(error);
      if (code)
        await this.persistence.transaction((state) => {
          const current = state.connections[connectionId].workCustody?.continuations.find(
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

function refusalCode(error: unknown) {
  const code =
    error instanceof ConnectorTransportError
      ? error.causeCode
      : error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
  return typeof code === 'string' &&
    [
      'WORK_DELEGATION_UNAVAILABLE',
      'WORK_OWNER_DECISION_REQUIRED',
      'PARTICIPATION_REVOKED',
      'CONNECTION_REVOKED',
      'WORK_AUTHORITY_REQUIRED',
      'WORK_SOURCE_AMBIGUOUS',
      'WORK_RESULT_NOT_CURRENT',
      'WORK_EXECUTION_NOT_CURRENT',
      'WORK_REVISION_CONFLICT',
      'COLLABORATION_OPERATION_CONFLICT',
    ].includes(code)
    ? code
    : undefined;
}
