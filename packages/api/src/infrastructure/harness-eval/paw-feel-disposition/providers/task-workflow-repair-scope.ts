import { taskFeatureIdSchema, type VerifiedPawFeelDirectRepairSourceV1 } from '@cat-cafe/shared';
import type { IMessageStore } from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import { inspectPawFeelMessage } from '../../friction/paw-feel-source.js';

const LIST_TASKS_TOOL_NAME = 'cat_cafe_list_tasks';
const FEATURE_ACTION_PREFIX = 'f160:list-tasks-feature-filter:feature:';
const NAMED_FEATURE_FILTER = /(?:^|[\s(,;，；])featureId\s*=\s*(F\d+)(?=$|[\s),;，；。])/gu;

export const F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION = 'f160:list-tasks-feature-filter';

export function f160ListTasksFeatureFilterRepairAction(featureId: string): string {
  return `${FEATURE_ACTION_PREFIX}${taskFeatureIdSchema.parse(featureId)}`;
}

type ParsedRepairAction = { kind: 'unscoped' } | { kind: 'scoped'; featureId: string };

export type TaskWorkflowRepairScopeResolution =
  | { status: 'resolved'; featureId: string }
  | { status: 'invalid_action' }
  | { status: 'source_scope_unproven' };

function parseRepairAction(actionRef: string): ParsedRepairAction | null {
  if (actionRef === F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION) return { kind: 'unscoped' };
  if (!actionRef.startsWith(FEATURE_ACTION_PREFIX)) return null;
  try {
    return { kind: 'scoped', featureId: taskFeatureIdSchema.parse(actionRef.slice(FEATURE_ACTION_PREFIX.length)) };
  } catch {
    return null;
  }
}

function namedSourceFeatureIds(symptom: string): string[] | null {
  const featureIds = new Set<string>();
  for (const match of symptom.matchAll(NAMED_FEATURE_FILTER)) {
    try {
      featureIds.add(taskFeatureIdSchema.parse(match[1]));
    } catch {
      return null;
    }
  }
  return [...featureIds];
}

async function readNamedSourceFeatureId(input: {
  source: VerifiedPawFeelDirectRepairSourceV1;
  messageStore: Pick<IMessageStore, 'getById'>;
  ownerUserId: string;
}): Promise<{ status: 'none' } | { status: 'single'; featureId: string } | { status: 'unproven' }> {
  const message = await input.messageStore.getById(input.source.sourceMessageId);
  if (
    !message ||
    message.id !== input.source.sourceMessageId ||
    message.threadId !== input.source.sourceThreadId ||
    message.userId !== input.ownerUserId
  ) {
    return { status: 'unproven' };
  }
  const inspection = inspectPawFeelMessage(message);
  const candidate =
    inspection.kind === 'canonical'
      ? inspection.candidates.find(
          (entry) =>
            entry.markerDigest === input.source.markerDigest &&
            entry.sameDigestOrdinal === input.source.sameDigestOrdinal &&
            entry.marker.tool?.trim().toLowerCase() === LIST_TASKS_TOOL_NAME,
        )
      : undefined;
  if (!candidate) return { status: 'unproven' };
  const featureIds = namedSourceFeatureIds(candidate.marker.symptom);
  if (featureIds === null || featureIds.length > 1) return { status: 'unproven' };
  const featureId = featureIds[0];
  return featureId ? { status: 'single', featureId } : { status: 'none' };
}

/**
 * Freeze the operation target from either an exact named source parameter or
 * the active repair owner's scoped action. Thread/Task feature metadata is not
 * an operation trace and must never select this scope.
 */
export async function resolveTaskWorkflowRepairScope(input: {
  actionRef: string;
  source: VerifiedPawFeelDirectRepairSourceV1;
  messageStore: Pick<IMessageStore, 'getById'>;
  ownerUserId: string;
}): Promise<TaskWorkflowRepairScopeResolution> {
  const action = parseRepairAction(input.actionRef);
  if (!action) return { status: 'invalid_action' };
  const sourceTarget = await readNamedSourceFeatureId(input);
  if (sourceTarget.status === 'unproven') return { status: 'source_scope_unproven' };
  if (sourceTarget.status === 'single') {
    if (action.kind === 'scoped' && action.featureId !== sourceTarget.featureId) {
      return { status: 'source_scope_unproven' };
    }
    return { status: 'resolved', featureId: sourceTarget.featureId };
  }
  return action.kind === 'scoped'
    ? { status: 'resolved', featureId: action.featureId }
    : { status: 'source_scope_unproven' };
}
