import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isOwnerVisibleManagedHoldConnector } from '../cats/services/stores/visibility.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import { classifyManagedHoldWake, findWakeTerminal } from './managed-hold-supersession.js';
import type { AdoptedManagedHold } from './TurnCustodyAdoptionRegistry.js';

export type ManagedHoldDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'userId' | 'catId' | 'threadId' | 'originTriggerMessageId'
>;

export class ManagedHoldDispositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManagedHoldDispositionError';
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
  const supersession = classifyManagedHoldWake(events, wakeIdentity);
  if (!prior && supersession.kind === 'wake_missing') {
    throw new ManagedHoldDispositionError('managed_hold_disposition_wake_missing');
  }
  return {
    ...sourceIdentity,
    primary: isPrimary,
    ...(prior ? { prior } : {}),
    retired: supersession.kind === 'superseded',
    withdrawn:
      source.deliveryStatus === 'canceled' ||
      source.deletedAt !== undefined ||
      source._tombstone === true ||
      source.queueCustody?.withdrawnByCatIds?.includes(auth.catId) === true,
    receiptHandled: source.queueCustody?.handledByCatIds.includes(auth.catId) === true,
  };
}

function identity(source: StoredMessage | null, auth: ManagedHoldDispositionAuth): HoldSource {
  const meta = source?.source?.meta;
  if (
    !source ||
    source.source?.connector !== 'hold-ball' ||
    meta?.wakeWhen !== true ||
    typeof meta.taskId !== 'string' ||
    !meta.taskId ||
    source.threadId !== auth.threadId ||
    meta.threadId !== auth.threadId ||
    meta.catId !== auth.catId
  )
    throw new ManagedHoldDispositionError('managed_hold_disposition_source_mismatch');
  return { sourceMessageId: source.id, taskId: meta.taskId };
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
  if (
    wake.taskId !== source.source?.meta?.taskId ||
    wake.holderCatId !== auth.catId ||
    wake.subjectKey !== `ball:thread:${auth.threadId}` ||
    !isOwnerVisibleManagedHoldConnector(source, auth.userId) ||
    !exposure ||
    !Number.isFinite(exposure.seenAt) ||
    exposure.seenAt > now ||
    (!completedByInvocation && custody?.seenInvocationIdByCatId[auth.catId] !== auth.invocationId)
  )
    throw new ManagedHoldDispositionError('managed_hold_disposition_adopted_source_mismatch');
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
    identity(source, auth);
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
  const selected = pending.length > 0 ? pending : exactReplay ? [exactReplay] : [];
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
