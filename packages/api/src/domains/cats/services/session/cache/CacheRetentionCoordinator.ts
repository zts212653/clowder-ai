import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type CacheRetentionSessionStatus, createCatId, type SessionRecord } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { TurnExecutionCacheFacts } from '../../stores/ports/TurnExecutionCacheFacts.js';
import { CacheRetentionJobs } from './CacheRetentionJobs.js';
import type { CacheRetentionProbeService } from './CacheRetentionProbeService.js';
import type { CacheRetentionSettingsStore } from './CacheRetentionSettingsStore.js';
import type { CacheRetentionStateStore } from './CacheRetentionStateStore.js';
import { retentionCandidate, retentionDispatchPending } from './cache-retention-dispatch.js';
import { retentionInputRefusal } from './cache-retention-input-boundary.js';
import { reconcileRetentionReturn, recoverRetentionReceipt } from './cache-retention-return.js';
import { stopInterruptedRetentionAttempt } from './cache-retention-settlement.js';
import {
  RETENTION_HORIZON_MS,
  RETENTION_LATE_MS,
  RETENTION_LEAD_MS,
  type RetentionCandidate,
  type RetentionWindow,
  retentionSourceKey,
  retentionWarmUntil,
  retentionWindowId,
} from './cache-retention-state.js';

export interface CacheRetentionCoordinatorDependencies {
  settings: Pick<CacheRetentionSettingsStore, 'get' | 'enabledMembers'>;
  cacheFacts?: TurnExecutionCacheFacts;
  store: CacheRetentionStateStore;
  sessions: Pick<ISessionChainStore, 'getActive'>;
  messages: Pick<IMessageStore, 'getById'>;
  probe: Pick<CacheRetentionProbeService, 'probe' | 'readReceipt'>;
  isSupported: (catId: string) => boolean;
  isBusy: (threadId: string, catId: string, userId: string) => boolean;
  now?: () => number;
  onError: (error: unknown) => void;
}

/** Only an explicit preference + current dispatched work can open a bounded idle window. */
export class CacheRetentionCoordinator {
  private readonly jobs: CacheRetentionJobs;
  private currentTick?: Promise<void>;
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly deps: CacheRetentionCoordinatorDependencies) {
    this.now = deps.now ?? Date.now;
    this.jobs = new CacheRetentionJobs(deps.onError);
  }

  async observeDispatch(message: StoredMessage, targets: readonly string[]): Promise<void> {
    const pointer = retentionCandidate(message, targets);
    if (pointer && this.deps.isSupported(pointer.catId)) {
      await this.deps.store.remember(pointer);
      await this.consider(pointer, false);
    }
  }
  async observeSource(record: SessionRecord): Promise<void> {
    const invocationId = record.lastUsage?.cacheObservation?.invocationId;
    if (!record.userId || !invocationId || !this.deps.isSupported(record.catId)) return;
    const pointer = await this.deps.store.sourcePointer({
      userId: record.userId,
      catId: record.catId,
      threadId: record.threadId,
      sourceInvocationId: invocationId,
    });
    if (pointer) await this.consider(pointer, false);
  }
  async close(): Promise<void> {
    this.closed = true;
    const jobs = this.jobs.close();
    await this.currentTick?.catch(this.deps.onError);
    await jobs;
  }
  async settleActive(): Promise<void> {
    await this.jobs.settle();
  }

  async preferenceChanged(userId: string, catId: string): Promise<void> {
    this.jobs.abortMember(userId, catId);
    for (const window of await this.deps.store.recent()) {
      if (window.userId !== userId || window.catId !== catId || window.state === 'stopped') continue;
      await this.stop(window, 'preference_changed');
    }
    if ((await this.deps.settings.get(userId, catId)).enabled)
      await this.recoverMember(userId, catId, false, Date.now() + 10_000);
  }
  async sessions(userId: string, catId: string): Promise<CacheRetentionSessionStatus[]> {
    return (await this.deps.store.recent())
      .filter((window) => window.userId === userId && window.catId === catId)
      .slice(0, 12)
      .map((window) => ({
        threadId: window.threadId,
        sessionId: window.sessionId,
        state: window.state,
        retainUntil: retentionWarmUntil(window),
        ...(window.reason ? { reason: window.reason } : {}),
        ...(window.returned?.readRatio !== undefined ? { lastReturnReadRatio: window.returned.readRatio } : {}),
      }));
  }
  tick(): Promise<void> {
    if (this.currentTick || this.closed) return this.currentTick ?? Promise.resolve();
    this.currentTick = this.scanTick().finally(() => {
      this.currentTick = undefined;
    });
    return this.currentTick;
  }
  private async dispatchDue(): Promise<void> {
    for (const window of await this.deps.store.due(this.now())) {
      if (this.closed) return;
      const pointer = window.candidateId ? await this.deps.store.candidate(window.candidateId) : null;
      if (pointer) await this.consider(pointer, true).catch(this.deps.onError);
    }
  }
  private async scanTick(): Promise<void> {
    // Already enrolled deadlines run before archive recovery or historical return bookkeeping.
    await this.dispatchDue();
    // Real returns are reconciled even after a toggle-off or the teammate has finished.
    for (const original of await this.deps.store.windowsToReconcile()) {
      const window = this.jobs.has(original.id)
        ? original
        : await recoverRetentionReceipt(original, this.deps.store, this.deps.probe).catch((error) => {
            this.deps.onError(error);
            return original;
          });
      if (window.receipts.length && !window.returned && !window.returnUnknown)
        await reconcileRetentionReturn(window, this.deps.store, this.deps.cacheFacts).catch(this.deps.onError);
      const latest = await this.deps.store.get(window.id);
      if (latest?.state !== 'stopped') {
        const preference = await this.deps.settings.get(window.userId, window.catId);
        const current = await this.current(window);
        if (
          !preference.enabled ||
          preference.revision !== window.preferenceRevision ||
          !this.deps.isSupported(window.catId)
        )
          await this.stop(latest ?? window, 'preference_changed');
        else if (this.now() >= window.retainUntil) await this.stop(latest ?? window, 'two_hour_limit');
        else if (
          !current ||
          current.id !== window.sessionId ||
          current.cliSessionId !== window.nativeSessionId ||
          !isDeepStrictEqual(current.lastUsage?.cacheObservation, window.source)
        )
          await this.stop(latest ?? window, 'source_changed');
      }
      const settled = await this.deps.store.get(window.id);
      if (
        settled?.state === 'stopped' &&
        (!settled.attempt || settled.attempt.completed) &&
        (settled.returned || settled.returnUnknown || !settled.receipts.length)
      )
        await this.deps.store.retireReconciliation(window.id);
    }
    const deadline = Date.now() + 10_000;
    for (const member of await this.deps.settings.enabledMembers())
      await this.recoverMember(member.userId, member.catId, false, deadline);
    await this.dispatchDue();
  }

  private async recoverMember(userId: string, catId: string, send: boolean, deadline: number): Promise<void> {
    if (!this.deps.isSupported(catId) || !(await this.deps.settings.get(userId, catId)).enabled) return;
    const considered = new Set<string>();
    for await (const page of this.deps.store.memberCandidates(userId, catId, deadline))
      for (const pointer of page) {
        if (this.closed || Date.now() >= deadline) return;
        const sourceKey = retentionSourceKey(pointer);
        if (considered.has(sourceKey)) continue;
        considered.add(sourceKey);
        await this.consider(pointer, send).catch(this.deps.onError);
      }
  }

  private async current(pointer: { userId: string; catId: string; threadId: string }): Promise<SessionRecord | null> {
    const record = await this.deps.sessions.getActive(createCatId(pointer.catId), pointer.threadId, pointer.userId);
    return record?.userId === pointer.userId &&
      record.catId === pointer.catId &&
      record.threadId === pointer.threadId &&
      record.status === 'active'
      ? record
      : null;
  }
  private async stop(window: RetentionWindow, reason: string): Promise<void> {
    await this.deps.store.save({ ...window, revision: window.revision + 1, state: 'stopped', reason }, window.revision);
  }
  private async inputCurrent(window: RetentionWindow): Promise<boolean> {
    const refusal = await retentionInputRefusal(window, this.deps.cacheFacts);
    if (!refusal) return true;
    await this.stop(window, refusal);
    return false;
  }
  private async pendingForSource(source: RetentionCandidate): Promise<RetentionCandidate | null | undefined> {
    if (
      this.now() < source.createdAt + RETENTION_HORIZON_MS &&
      (await retentionDispatchPending(this.deps.messages, source))
    )
      return source;
    const group = await this.deps.store.sourceCandidates(source);
    const key = retentionSourceKey(source);
    for (const pointer of group.pointers) {
      if (retentionSourceKey(pointer) !== key || this.now() >= pointer.createdAt + RETENTION_HORIZON_MS) continue;
      if (await retentionDispatchPending(this.deps.messages, pointer)) return pointer;
    }
    // An incomplete reference page cannot prove that all dispatched work has finished.
    return group.complete ? null : undefined;
  }
  private async consider(pointer: RetentionCandidate, send = true): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    if (now >= pointer.createdAt + RETENTION_HORIZON_MS) {
      await this.deps.store.retire(pointer.id);
      return;
    }
    const preference = await this.deps.settings.get(pointer.userId, pointer.catId);
    if (!preference.enabled || !this.deps.isSupported(pointer.catId)) return;
    const record = await this.current(pointer),
      source = record?.lastUsage?.cacheObservation;
    if (
      !record?.cliSessionId ||
      !source ||
      source.invocationId !== pointer.sourceInvocationId ||
      source.nativeSessionId !== record.cliSessionId ||
      source.compressionCount !== record.compressionCount ||
      source.retentionSource !== 'usage_ttl' ||
      source.retentionMs !== 3_600_000 ||
      (record.compressionObservation?.observedAt ?? 0) > source.observedAt
    )
      return;
    const id = retentionWindowId(pointer.userId, pointer.catId, pointer.threadId, record.id, source.invocationId);
    let window = await this.deps.store.get(id);
    const pendingSource = await this.pendingForSource(pointer);
    if (!pendingSource) {
      if (pendingSource === null && window && window.state !== 'stopped')
        await this.stop(window, 'dispatch_finished_or_unverifiable');
      return;
    }
    if ((await this.deps.store.health(pointer.userId, pointer.catId, record.id))?.stopped) return;
    if (!window) {
      const sourceInputSequence = await this.deps.cacheFacts?.sequenceOf(pointer, source.invocationId);
      const fresh: RetentionWindow = {
        id,
        revision: 1,
        userId: pointer.userId,
        catId: pointer.catId,
        threadId: pointer.threadId,
        sessionId: record.id,
        nativeSessionId: record.cliSessionId,
        source,
        ...(sourceInputSequence !== undefined ? { sourceInputSequence } : {}),
        candidateId: pointer.id,
        preferenceRevision: preference.revision,
        dueAt: source.requestStartedAt + source.retentionMs - RETENTION_LEAD_MS,
        retainUntil: source.requestStartedAt + RETENTION_HORIZON_MS,
        state: 'waiting',
        receipts: [],
      };
      if (!(await this.deps.store.save(fresh, 0))) return;
      window = fresh;
    }
    if (window.state === 'stopped' || !(await this.inputCurrent(window))) return;
    if (window.attempt && !window.attempt.completed) {
      if (!this.jobs.has(window.id))
        await stopInterruptedRetentionAttempt(this.deps.store, window.id, window.attempt.id);
      return;
    }
    if (!send || this.deps.isBusy(pointer.threadId, pointer.catId, pointer.userId)) return;
    if (window.preferenceRevision !== preference.revision) {
      await this.stop(window, 'preference_changed');
      return;
    }
    if (now < window.dueAt) return;
    if (now >= window.dueAt + RETENTION_LATE_MS || now >= window.retainUntil - RETENTION_LATE_MS) {
      await this.stop(window, 'window_missed');
      return;
    }
    const claim: RetentionWindow = {
      ...window,
      revision: window.revision + 1,
      state: 'retaining',
      attempt: { id: randomUUID(), startedAt: now, completed: false },
    };
    if (!(await this.deps.store.save(claim, window.revision))) return;
    if (!this.jobs.start(claim, (signal) => this.performProbe(claim, record, pointer, pendingSource, signal)))
      await this.stop(claim, 'maintenance_stopped_before_send');
  }
  private async performProbe(
    claim: RetentionWindow,
    record: SessionRecord,
    pointer: RetentionCandidate,
    waitingSource: RetentionCandidate,
    signal: AbortSignal,
  ): Promise<void> {
    const id = claim.id;
    try {
      const receipt = await this.deps.probe.probe({
        userId: pointer.userId,
        catId: createCatId(pointer.catId),
        threadId: pointer.threadId,
        signal,
        attemptId: claim.attempt!.id,
        warmProof: await this.deps.store.proof(record),
        captureReturnBoundary: async () => {
          if (!(await this.inputCurrent(claim))) throw new Error('cache_retention_input_boundary_refused');
          return claim.sourceInputSequence!;
        },
        assertCurrent: async () => {
          signal.throwIfAborted();
          const [policy, current, stored, waiting] = await Promise.all([
            this.deps.settings.get(pointer.userId, pointer.catId),
            this.current(pointer),
            this.deps.store.get(id),
            this.pendingForSource(waitingSource),
          ]);
          if (
            !policy.enabled ||
            policy.revision !== claim.preferenceRevision ||
            !this.deps.isSupported(pointer.catId) ||
            this.deps.isBusy(pointer.threadId, pointer.catId, pointer.userId) ||
            stored?.state !== 'retaining' ||
            stored.attempt?.id !== claim.attempt!.id ||
            !waiting ||
            current?.id !== claim.sessionId ||
            current.cliSessionId !== claim.nativeSessionId ||
            !isDeepStrictEqual(current.lastUsage?.cacheObservation, claim.source) ||
            this.now() >= claim.dueAt + RETENTION_LATE_MS ||
            this.now() >= claim.retainUntil - RETENTION_LATE_MS
          )
            throw new Error('cache_retention_current_window_refused');
          if (!(await this.inputCurrent(claim))) throw new Error('cache_retention_input_boundary_refused');
          waitingSource = waiting;
        },
      });
      if (!(await this.deps.store.settleReceipt(id, claim.attempt!.id, receipt)))
        throw new Error('cache_retention_receipt_settlement_refused');
    } catch (error) {
      const latest = await this.deps.store.get(id);
      if (latest && latest.state !== 'stopped') await this.stop(latest, 'maintenance_failed_cost_unconfirmed');
      this.deps.onError(error);
    }
  }
}
