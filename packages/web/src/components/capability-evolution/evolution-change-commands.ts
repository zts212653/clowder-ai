import { apiFetch } from '@/utils/api-client';
import {
  type EvolutionChangeLineage,
  type EvolutionProgramProjection,
  isOwnerRef,
  isProjection,
} from './evolution-program-projection';

export type MetabolismDecision = 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change';

export type ChangeAction = { kind: 'sync' } | { kind: 'decide'; decision: MetabolismDecision };

type ChangeResponseBody = {
  outcome?: string;
  projection?: unknown;
  blockerRef?: unknown;
  blockerReason?: unknown;
  detail?: string;
};

function actionIdentity(action: ChangeAction): string {
  return action.kind === 'decide' ? `decide-${action.decision}` : action.kind;
}

function changeClientMessageId(programId: string, action: ChangeAction, sequence: number): string {
  return `workbench:change:${actionIdentity(action)}:${programId}:sequence:${sequence}`;
}

function blockedNotice(body: ChangeResponseBody): string {
  if (body.blockerRef !== undefined && !isOwnerRef(body.blockerRef)) {
    throw new Error('Change owner returned an invalid blocker reference');
  }
  if (isOwnerRef(body.blockerRef)) return `执行方暂未完成这次操作。来源：${body.blockerRef.ownerStateRef}`;
  const reason = typeof body.blockerReason === 'string' ? body.blockerReason.trim() : '';
  return `执行方暂未完成这次操作。原因：${reason || 'owner_blocked'}`;
}

async function readChangeResponse(response: Response): Promise<{
  projection: EvolutionProgramProjection;
  notice: string;
}> {
  const body = (await response.json()) as ChangeResponseBody;
  const isConflict = response.status === 409 && body.outcome === 'conflict';
  if ((!response.ok && !isConflict) || !isProjection(body.projection)) {
    throw new Error(body.detail ?? `Change owner request failed (${response.status})`);
  }
  if (body.outcome === 'blocked') {
    return { projection: body.projection, notice: blockedNotice(body) };
  }
  if (isConflict) {
    return { projection: body.projection, notice: '项目已同步到最新状态，请按当前状态继续。' };
  }
  if (body.outcome === 'waiting') {
    return {
      projection: body.projection,
      notice: '执行方仍在处理，尚未收到完成回执。',
    };
  }
  return { projection: body.projection, notice: '已同步这次改动的来源记录。' };
}

export function canDecideChange(projection: EvolutionProgramProjection, current?: EvolutionChangeLineage): boolean {
  return (
    projection.program.lifecycle === 'active' &&
    projection.program.stage === 'deciding' &&
    current?.status === 'outcome' &&
    current.interventionReceiptRef !== undefined &&
    current.assetVersionRef !== undefined &&
    current.outcomeReceiptRef !== undefined &&
    (current.interventionKind === 'no_change' || current.loadedRuntimeRef !== undefined) &&
    current.freshnessProofRef !== undefined
  );
}

export async function writeEvolutionChange(projection: EvolutionProgramProjection, action: ChangeAction) {
  const clientMessageId = changeClientMessageId(projection.program.programId, action, projection.program.sequence);
  const response = await apiFetch(
    `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}/changes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedSequence: projection.program.sequence,
        clientMessageId,
        action,
      }),
    },
  );
  const result = await readChangeResponse(response);
  if (
    result.projection.program.programId !== projection.program.programId ||
    result.projection.program.workspaceId !== projection.program.workspaceId
  )
    throw new Error('返回的记录与当前项目不一致，请刷新。');
  return result;
}
