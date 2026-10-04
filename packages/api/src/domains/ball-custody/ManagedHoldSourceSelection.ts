import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isOwnerVisibleManagedHoldConnector } from '../cats/services/stores/visibility.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type {
  ManagedHoldReplayMismatchBranch,
  ManagedHoldReplayMismatchDetail,
  ManagedHoldStoredTerminal,
} from './managed-hold-replay-mismatch.js';
import { classifyManagedHoldRetirement } from './managed-hold-retirement.js';
import { findWakeTerminal } from './managed-hold-supersession.js';
import type { AdoptedManagedHold } from './TurnCustodyAdoptionRegistry.js';

export type ManagedHoldDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'userId' | 'catId' | 'threadId' | 'originTriggerMessageId'
>;

export class ManagedHoldDispositionError extends Error {
  readonly branch?: ManagedHoldReplayMismatchBranch;
  readonly existingTerminal?: ManagedHoldStoredTerminal;

  constructor(
    readonly code: string,
    readonly diagnostic?: {
      readonly sourceMessageId?: string;
      readonly taskId?: string;
      readonly condition: string;
    },
    mismatch?: ManagedHoldReplayMismatchDetail,
  ) {
    super(code);
    this.name = 'ManagedHoldDispositionError';
    if (mismatch) {
      this.branch = mismatch.branch;
      if (mismatch.existingTerminal) this.existingTerminal = mismatch.existingTerminal;
    }
  }
}

interface HoldSource {
  readonly sourceMessageId: string;
  readonly taskId: string;
}

export interface ManagedHoldGuidance {
  readonly state: 'single_canonical_pending' | 'ambiguous_multiple_pending' | 'no_obligation';
  readonly candidates: readonly HoldSource[];
  readonly instruction: string;
}

interface Candidate extends HoldSource {
  readonly primary: boolean;
  readonly prior?: BallCustodyEvent;
  readonly retired: boolean;
  readonly withdrawn: boolean;
  readonly receiptHandled: boolean;
  readonly wakeSequence: number;
}

function classifyCandidate(
  source: StoredMessage,
  isPrimary: boolean,
  auth: ManagedHoldDispositionAuth,
  events: readonly BallCustodyEvent[],
): Candidate {
  const sourceIdentity = identity(source, auth);
  const wakeIdentity = { ...sourceIdentity, catId: auth.catId };
  const prior = findWakeTerminal(events, wakeIdentity);
  // The SAME verdict completeSource acts on. Whether a wake is retired decides which candidates are live
  // (ambiguity) and which drain one receipt at a time, so reading it more narrowly than the write side
  // listed wakes as live that completeSource would retire, and refused the call before it got there.
  const retirement = classifyManagedHoldRetirement(events, wakeIdentity);
  if (!prior && retirement.kind === 'wake_missing') {
    throw new ManagedHoldDispositionError('managed_hold_disposition_wake_missing', {
      ...sourceIdentity,
      condition: 'wake_missing',
    });
  }
  return {
    ...sourceIdentity,
    primary: isPrimary,
    ...(prior ? { prior } : {}),
    retired: retirement.kind === 'retired',
    withdrawn:
      source.deliveryStatus === 'canceled' ||
      source.deletedAt !== undefined ||
      source._tombstone === true ||
      source.queueCustody?.withdrawnByCatIds?.includes(auth.catId) === true,
    receiptHandled: source.queueCustody?.handledByCatIds.includes(auth.catId) === true,
    wakeSequence: events.findIndex(
      (event) =>
        event.kind === 'ball.wake_condition_met' &&
        event.payload.taskId === sourceIdentity.taskId &&
        event.payload.catId === auth.catId,
    ),
  };
}

function identity(source: StoredMessage | null, auth: ManagedHoldDispositionAuth, ref?: HoldSource): HoldSource {
  const meta = source?.source?.meta;
  const taskId = meta?.taskId;
  const sourceMessageId = ref?.sourceMessageId ?? source?.id;
  const diagnosticTaskId = ref?.taskId ?? (typeof taskId === 'string' ? taskId : undefined);
  const mismatch = (condition: string) =>
    new ManagedHoldDispositionError('managed_hold_disposition_source_mismatch', {
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(diagnosticTaskId ? { taskId: diagnosticTaskId } : {}),
      condition,
    });
  if (!source) throw mismatch('source_missing');
  if (source.source?.connector !== 'hold-ball') throw mismatch('connector_mismatch');
  if (meta?.wakeWhen !== true) throw mismatch('wake_when_mismatch');
  if (typeof taskId !== 'string' || !taskId) throw mismatch('task_id_missing');
  if (source.threadId !== auth.threadId) throw mismatch('source_thread_mismatch');
  if (meta.threadId !== auth.threadId) throw mismatch('metadata_thread_mismatch');
  if (meta.catId !== auth.catId) throw mismatch('cat_mismatch');
  return { sourceMessageId: source.id, taskId };
}

function verifyAdoptedSource(
  source: StoredMessage,
  wake: AdoptedManagedHold,
  auth: ManagedHoldDispositionAuth,
  now: number,
): void {
  const custody = source.queueCustody;
  const exposure = custody?.bodyExposures?.find(
    (item) => item.targetCatId === auth.catId && item.invocationId === auth.invocationId,
  );
  // Completion retires the live seen binding; its exact durable outcome retains
  // which child handled the exposure. It must not poison a later read or replay.
  const completedByInvocation =
    custody?.handledByCatIds.includes(auth.catId) === true &&
    !custody.pendingTargetCats.includes(auth.catId) &&
    custody.targetOutcomeByCatId?.[auth.catId]?.invocationId === auth.invocationId;
  const mismatch = (condition: string) =>
    new ManagedHoldDispositionError('managed_hold_disposition_adopted_source_mismatch', {
      sourceMessageId: wake.sourceMessageId,
      taskId: wake.taskId,
      condition,
    });
  if (wake.taskId !== source.source?.meta?.taskId) throw mismatch('task_id_mismatch');
  if (wake.holderCatId !== auth.catId) throw mismatch('holder_mismatch');
  if (wake.subjectKey !== `ball:thread:${auth.threadId}`) throw mismatch('subject_mismatch');
  if (!isOwnerVisibleManagedHoldConnector(source, auth.userId)) throw mismatch('owner_not_visible');
  if (!exposure) throw mismatch('exposure_missing');
  if (!Number.isFinite(exposure.seenAt)) throw mismatch('exposure_time_invalid');
  if (exposure.seenAt > now) throw mismatch('exposure_time_future');
  if (!completedByInvocation && custody?.seenInvocationIdByCatId[auth.catId] !== auth.invocationId)
    throw mismatch('seen_binding_mismatch');
}

/** Select within a call-entry snapshot; neither Queue recency nor generic task state grants authority. */
export async function selectManagedHoldSource(
  deps: {
    messageStore: Pick<IMessageStore, 'getById'>;
    ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  },
  auth: ManagedHoldDispositionAuth,
  adopted: readonly AdoptedManagedHold[],
  now: number,
): Promise<ManagedHoldGuidance> {
  const origin = auth.originTriggerMessageId ? await deps.messageStore.getById(auth.originTriggerMessageId) : null;
  const primary = origin?.source?.connector === 'hold-ball' ? identity(origin, auth) : undefined;
  const refs = new Map(adopted.map((wake) => [wake.sourceMessageId, wake]));
  if (primary) refs.delete(primary.sourceMessageId);
  const sources: Array<{ source: StoredMessage; primary: boolean }> = [];
  if (origin && primary) sources.push({ source: origin, primary: true });
  for (const wake of refs.values()) {
    const source = await deps.messageStore.getById(wake.sourceMessageId);
    identity(source, auth, wake);
    if (!source) throw new ManagedHoldDispositionError('managed_hold_disposition_source_missing');
    verifyAdoptedSource(source, wake, auth, now);
    sources.push({ source, primary: false });
  }
  const events = await deps.ballCustodyEventLog.read(`ball:thread:${auth.threadId}`);
  const candidates = sources.map(({ source, primary }) => classifyCandidate(source, primary, auth, events));
  const available = candidates.filter((candidate) => !candidate.withdrawn);
  const repairs = available.filter((candidate) => candidate.prior && !candidate.receiptHandled);
  const pending =
    repairs.length > 0
      ? repairs
      : available.filter((candidate) => !candidate.prior && !candidate.retired && !candidate.receiptHandled);
  // Preserve exact original-trigger retirement and a single adopted source's idempotent replay.
  const exactReplay =
    available.find((candidate) => candidate.primary) ??
    (available.length === 1 && available[0]?.prior ? available[0] : undefined);
  // Supersession retires the subject obligation, not its uncommitted Queue
  // receipt. Drain proven retired wakes individually in durable event order;
  // do not ask a later invocation to rediscover them or choose from page order.
  // Live ambiguity and event-before-receipt repairs retain their precedence.
  const retired = available
    .filter((candidate) => !candidate.prior && candidate.retired && !candidate.receiptHandled)
    .sort((a, b) => a.wakeSequence - b.wakeSequence);
  const retirement = retired.find((candidate) => candidate.primary) ?? retired[0];
  const selected = pending.length > 0 ? pending : retirement ? [retirement] : exactReplay ? [exactReplay] : [];
  const state =
    selected.length === 1
      ? 'single_canonical_pending'
      : selected.length > 1
        ? 'ambiguous_multiple_pending'
        : 'no_obligation';
  return {
    state,
    candidates: selected.map(({ sourceMessageId, taskId }) => ({ sourceMessageId, taskId })),
    instruction:
      state === 'single_canonical_pending'
        ? '本轮已接入这条持球通知。工作已完成时调用 cat_cafe_complete_managed_hold，仅填写 disposition=handled 或 completed；未完成则用已授权的 hold_ball、已注册的事件回调或结构化传球。命令退出、阅读或测试通过不代替通知结算。'
        : state === 'ambiguous_multiple_pending'
          ? '多条待结算通知无法唯一绑定；不要猜选或批量完成。按现有持球/传球或用户撤回使候选收敛，再完整读取确认；失败时保留来源并报告。'
          : '当前没有待显式结算的持球通知；不要把这个结果作为其他任务完成的证明。',
  };
}
