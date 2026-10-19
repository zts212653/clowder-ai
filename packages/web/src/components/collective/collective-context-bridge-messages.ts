import {
  type CollectiveAcceptedWorkResult,
  type CollectiveClientContext,
  collectiveClientAccountabilityChangedSchema,
  collectiveClientWorkResultAcceptedSchema,
} from '@cat-cafe/shared';
import type { CollectiveWorkActionTarget } from './collective-work-action';

export interface BridgeGeneration {
  bridgeId: string;
  contextId?: string;
  revision: number;
}

export interface BridgeConnection {
  serviceOrigin: string;
  serviceInstanceId: string;
  collectiveId: string;
  connectionId: string;
  authorizedHumanId: string;
}

export function handleCollectiveAccountabilityChange(
  data: unknown,
  active: BridgeGeneration | undefined,
  connection: BridgeConnection,
): boolean {
  const parsed = collectiveClientAccountabilityChangedSchema.safeParse(data);
  if (!parsed.success) return false;
  const value = parsed.data;
  if (active && accountabilityChangeMatches(value, active, connection)) {
    window.dispatchEvent(
      new CustomEvent('cat-cafe:collective-attention-invalidated', {
        detail: {
          connectionId: value.connectionId,
          workId: value.workId,
          workRevision: value.workRevision,
          accountabilityRequestId: value.accountabilityRequestId,
          status: value.status,
        },
      }),
    );
  }
  return true;
}

export function collectiveFocusKey(context: CollectiveClientContext, target: CollectiveWorkActionTarget): string {
  const specific =
    target.kind === 'collective-work'
      ? `${target.resultEventId}:${target.resultRevision}`
      : `${target.roadmapId}:${target.accountabilityRequestId}`;
  return `${context.bridgeId}:${context.contextId}:${context.revision}:${target.connectionId}:${target.kind}:${target.workId}:${target.workRevision}:${specific}`;
}

export function collectiveFocusMessage(context: CollectiveClientContext, target: CollectiveWorkActionTarget) {
  const base = {
    bridgeId: context.bridgeId,
    contextId: context.contextId,
    contextRevision: context.revision,
    workId: target.workId,
    workRevision: target.workRevision,
    channelId: target.channelId,
  };
  return target.kind === 'collective-work'
    ? {
        type: 'collective:host-focus-work' as const,
        ...base,
        resultEventId: target.resultEventId,
        resultRevision: target.resultRevision,
      }
    : {
        type: 'collective:host-focus-project-work' as const,
        ...base,
        roadmapId: target.roadmapId,
        accountabilityRequestId: target.accountabilityRequestId,
      };
}

export function queueAcceptedWorkResult(input: {
  data: unknown;
  active?: BridgeGeneration;
  connection: BridgeConnection;
  pending: Map<string, Promise<void>>;
  reconcile?: (evidence: CollectiveAcceptedWorkResult) => Promise<void>;
  currentGeneration: () => BridgeGeneration | undefined;
  postToClient: (message: unknown) => void;
}): boolean {
  const parsed = collectiveClientWorkResultAcceptedSchema.safeParse(input.data);
  if (!parsed.success) return false;
  const value = parsed.data;
  if (!input.active || !input.reconcile || !acceptedWorkMatches(value, input.active, input.connection)) return true;
  const key = `${value.bridgeId}:${value.workId}:${value.workRevision}`;
  if (input.pending.has(key)) return true;
  const operation = input
    .reconcile(acceptedEvidence(value))
    .then(() => {
      const latest = input.currentGeneration();
      if (!reconciliationContextMatches(value, latest)) return;
      input.postToClient({
        type: 'collective:host-work-result-reconciled',
        bridgeId: value.bridgeId,
        contextId: value.contextId,
        contextRevision: value.contextRevision,
        workId: value.workId,
        workRevision: value.workRevision,
      });
    })
    .catch(() => undefined)
    .finally(() => {
      if (input.pending.get(key) === operation) input.pending.delete(key);
    });
  input.pending.set(key, operation);
  return true;
}

function accountabilityChangeMatches(
  value: ReturnType<typeof collectiveClientAccountabilityChangedSchema.parse>,
  active: BridgeGeneration,
  connection: BridgeConnection,
) {
  return (
    value.bridgeId === active.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    value.connectionId === connection.connectionId &&
    value.humanId === connection.authorizedHumanId
  );
}

function acceptedWorkMatches(
  value: ReturnType<typeof collectiveClientWorkResultAcceptedSchema.parse>,
  active: BridgeGeneration,
  connection: BridgeConnection,
) {
  return (
    value.bridgeId === active.bridgeId &&
    value.contextId === active.contextId &&
    value.contextRevision === active.revision &&
    value.serviceInstanceId === connection.serviceInstanceId &&
    value.collectiveId === connection.collectiveId &&
    value.connectionId === connection.connectionId &&
    value.humanId === connection.authorizedHumanId
  );
}

function acceptedEvidence(
  value: ReturnType<typeof collectiveClientWorkResultAcceptedSchema.parse>,
): CollectiveAcceptedWorkResult {
  return {
    serviceInstanceId: value.serviceInstanceId,
    collectiveId: value.collectiveId,
    connectionId: value.connectionId,
    workId: value.workId,
    workRevision: value.workRevision,
    assignmentEventId: value.assignmentEventId,
    resultEventId: value.resultEventId,
    resultRevision: value.resultRevision,
  };
}

function reconciliationContextMatches(
  value: ReturnType<typeof collectiveClientWorkResultAcceptedSchema.parse>,
  latest?: BridgeGeneration,
) {
  return (
    latest?.bridgeId === value.bridgeId &&
    latest.contextId === value.contextId &&
    latest.revision === value.contextRevision
  );
}
