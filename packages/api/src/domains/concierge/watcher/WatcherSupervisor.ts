import {
  catRegistry,
  parseWatcherSessionState,
  type SessionRecord,
  type TurnExecutionRecord,
  type WatcherCapability,
} from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../../cats/services/session/session-scope.js';
import { awaitStoreRead } from '../../cats/services/stores/ports/StoreReadOptions.js';
import type { ILabelStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../../cats/services/types.js';
import type { IConciergeConfigStore } from '../ConciergeConfigStore.js';
import { watcherRetirementPending } from './retirement/watcher-retirement-state.js';
import { saveWatcherState } from './watcher-checkpoint.js';
import { effectiveWatcherState, readWatcherPreferences } from './watcher-controls.js';
import { finalizeWatcherWake, finishIdleWatcherWake } from './watcher-finalization.js';
import { runWatcherInvocation } from './watcher-invocation.js';
import type { WatcherInvocationOwners } from './watcher-invocation-contract.js';
import { reconcileWatcherRecovery } from './watcher-recovery.js';
import { reserveWatcherRecovery, watcherRecoveryFinalizationDue } from './watcher-retry.js';
import { recordWatcherSourceFailure, watcherSourceFinished } from './watcher-source-result.js';

interface Options extends WatcherInvocationOwners {
  userId: string;
  configs: IConciergeConfigStore;
  labels: ILabelStore;
  service(catId: string): AgentService | undefined;
  capability(catId: string): WatcherCapability | Promise<WatcherCapability>;
  report(error: unknown, threadId?: string): void;
  run?: typeof runWatcherInvocation;
}

/** F191's durable ordered settlement index is the only wake source. The work commit never awaits this consumer. */
export class WatcherSupervisor {
  private cursor = 0;
  private floor = 0;
  private polling = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Set<string>();
  private readonly retryThreads = new Set<string>();
  private readonly active = new Map<
    string,
    { abort: AbortController; promise: Promise<void>; catId?: string; controlOnly?: boolean }
  >();
  constructor(private readonly deps: Options) {}

  isReady(): boolean {
    return this.timer !== undefined && !this.stopped;
  }
  async start(): Promise<void> {
    await this.reconcile();
    if (!this.deps.configs.initializeWatcherCursor) throw new Error('watcher_cursor_owner_unavailable');
    this.floor = await this.deps.configs.initializeWatcherCursor(
      this.deps.userId,
      await this.deps.executions.settledHead(this.deps.userId),
    );
    this.cursor = this.floor;
    this.timer = setInterval(() => void this.poll().catch((error) => this.deps.report(error)), 1000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const current of this.active.values()) current.abort.abort(new Error('watcher_supervisor_stopped'));
    await Promise.allSettled([...this.active.values()].map((current) => current.promise));
  }
  controlChanged(threadId?: string): void {
    void (async () => {
      const preferences = await readWatcherPreferences(this.deps.configs, this.deps.labels, this.deps.userId);
      for (const [id, current] of this.active) {
        if (current.controlOnly || (threadId && id !== threadId)) continue;
        const thread = await this.deps.threads.get(id);
        if (
          !thread ||
          (current.catId !== undefined && current.catId !== preferences.config.memberCatId) ||
          !effectiveWatcherState(preferences.config, thread, preferences.quietLabels).enabled
        )
          current.abort.abort(new Error('watcher_disabled'));
      }
    })().catch((error) => this.deps.report(error, threadId));
  }
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      await this.reconcile();
      for (const threadId of this.retryThreads) this.schedule(threadId);
      this.retryThreads.clear();
      const page = await this.deps.executions.listSettled({
        userId: this.deps.userId,
        afterSequence: this.cursor,
        limit: 100,
      });
      for (const source of page.records) {
        if (source.executionKind !== 'ordinary') continue;
        this.schedule(source.threadId);
      }
      this.cursor = page.nextCursor;
    } finally {
      this.polling = false;
    }
  }
  private reconcile(): Promise<void> {
    return reconcileWatcherRecovery(
      {
        ...this.deps,
        recoverNative: (session, source) => {
          if (this.stopped || this.active.has(session.threadId)) return;
          this.activate(
            session.threadId,
            session.catId,
            async (signal) => {
              const read = <T>(value: T | Promise<T>) => awaitStoreRead(Promise.resolve(value), { signal });
              const preferences = await read(
                readWatcherPreferences(this.deps.configs, this.deps.labels, this.deps.userId),
              );
              const thread = await read(this.deps.threads.get(session.threadId));
              if (!thread) throw new Error('watcher_recovery_thread_missing');
              const state = parseWatcherSessionState(session.watcherState);
              // Off means no new CLI, including a control-only recovery. Proven
              // startup failures/finalize_pending already settle without a provider.
              if (!effectiveWatcherState(preferences.config, thread, preferences.quietLabels).enabled) {
                if (!state.attempt && !watcherRetirementPending(session))
                  await finishIdleWatcherWake(this.deps, session, source);
                return;
              }
              const retirement = watcherRetirementPending(session);
              const activation = `${preferences.config.activationRevision ?? 0}:${thread.watcher?.activationRevision ?? 0}`;
              const recoveryOnly =
                retirement ||
                watcherRecoveryFinalizationDue(state, this.deps.now?.() ?? Date.now()) ||
                preferences.config.memberCatId !== session.catId ||
                !effectiveWatcherState(preferences.config, thread, preferences.quietLabels).enabled ||
                state.activationCut !== activation;
              const active = this.active.get(session.threadId);
              if (active) active.controlOnly = recoveryOnly && !retirement;
              if (
                !retirement &&
                !(await reserveWatcherRecovery(
                  this.deps,
                  session,
                  state,
                  this.deps.now?.() ?? Date.now(),
                  recoveryOnly ? `${preferences.config.revision}:${thread.watcher?.revision ?? 0}` : undefined,
                ))
              )
                return;
              const service = this.deps.service(session.catId);
              if (!service) throw new Error('WATCHER_SESSION_UNSUPPORTED');
              await (this.deps.run ?? runWatcherInvocation)(this.deps, {
                session,
                source,
                service,
                quiet: true,
                recoveryOnly,
                signal,
              });
              if (retirement && (await this.deps.sessions.get(session.id))?.watcherRetirement?.phase === 'retired')
                this.pending.add(session.threadId);
            },
            true,
          );
        },
      },
      this.deps.userId,
      this.deps.report,
      new Set(this.active.keys()),
    );
  }
  private schedule(threadId: string): void {
    if (this.stopped) return;
    if (this.active.has(threadId)) {
      this.pending.add(threadId);
      return;
    }
    this.activate(threadId, undefined, (signal) => this.drain(threadId, signal));
  }
  private activate(
    threadId: string,
    catId: string | undefined,
    work: (signal: AbortSignal) => Promise<void>,
    recovering = false,
  ): void {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('watcher_deadline_exceeded')), 90_000);
    timer.unref?.();
    const promise = work(abort.signal)
      .catch((error) => {
        this.deps.report(error, threadId);
        if (!this.stopped && !recovering) this.retryThreads.add(threadId);
      })
      .finally(() => {
        clearTimeout(timer);
        this.active.delete(threadId);
        if (this.pending.delete(threadId)) this.schedule(threadId);
      });
    this.active.set(threadId, { abort, promise, ...(catId ? { catId } : {}) });
  }
  private async drain(threadId: string, signal: AbortSignal): Promise<void> {
    const read = <T>(value: T | Promise<T>) => awaitStoreRead(Promise.resolve(value), { signal });
    const preferences = await read(readWatcherPreferences(this.deps.configs, this.deps.labels, this.deps.userId));
    const catId = preferences.config.memberCatId;
    const active = this.active.get(threadId);
    if (active) active.catId = catId;
    const member = catRegistry.tryGet(catId);
    if (!member) {
      // The chosen member can leave the roster while its preference persists. When watching is
      // off or this thread is not picked there is nothing to run, so do not retry every poll;
      // existing sessions keep their cursors and earlier wakes still settle in reconcile().
      const thread = await read(this.deps.threads.get(threadId));
      if (!thread || thread.deletedAt) return;
      if (!effectiveWatcherState(preferences.config, thread, preferences.quietLabels).enabled) return;
      throw new Error('WATCHER_SESSION_UNSUPPORTED');
    }
    // The provider is only needed to actually run a wake. Resolving it up front made an
    // unavailable member retry every poll even while watching was off for this thread.
    let service: ReturnType<Options['service']> | undefined;
    const requireService = async () => {
      service ??= this.deps.service(catId);
      if (!service || !(await read(this.deps.capability(catId))).supported)
        throw new Error('WATCHER_SESSION_UNSUPPORTED');
      return service;
    };
    const chainKey = watcherSessionChainKey(this.deps.userId, catId, threadId);
    let session: SessionRecord = await read(
      this.deps.sessions.getOrCreateActive({
        userId: this.deps.userId,
        catId: member.config.id,
        threadId,
        sessionPurpose: 'watcher',
        chainKey,
      }),
    );
    if (!session.watcherState)
      await saveWatcherState(this.deps.sessions, session.id, parseWatcherSessionState(undefined), {
        afterSequence: this.floor,
      });
    let scan = parseWatcherSessionState(session.watcherState).afterSequence;
    for (let count = 0; count < 100 && !signal.aborted; count++) {
      session = (await read(this.deps.sessions.getByChainKey(chainKey)))!;
      if (!session) return;
      const state = parseWatcherSessionState(session.watcherState);
      if (state.attempt?.phase === 'finalize_pending') {
        await finalizeWatcherWake(this.deps, session, state);
        continue;
      }
      const page = await read(
        this.deps.executions.listSettled({
          userId: this.deps.userId,
          threadId,
          afterSequence: Math.max(scan, state.afterSequence),
          limit: 1,
        }),
      );
      const source: TurnExecutionRecord | null | undefined =
        session.watcherRetirement && session.watcherRetirement.phase !== 'retired'
          ? await read(this.deps.executions.get(session.watcherRetirement.sourceInvocationId))
          : state.attempt
            ? await read(this.deps.executions.get(state.attempt.sourceInvocationId))
            : page.records[0];
      if (!source) return;
      if (
        !state.attempt &&
        !watcherRetirementPending(session) &&
        (await watcherSourceFinished(this.deps.executions, member.config.id, source.invocationId))
      ) {
        if (
          state.wakeInvocationId &&
          (await read(this.deps.executions.get(state.wakeInvocationId)))?.causal?.watcherSourceInvocationId ===
            source.invocationId
        )
          await saveWatcherState(this.deps.sessions, session.id, state, { wakeInvocationId: undefined });
        scan = source.settledSequence!;
        continue;
      }
      const thread = await read(this.deps.threads.get(threadId));
      if (!thread || thread.deletedAt) return;
      const current = await read(readWatcherPreferences(this.deps.configs, this.deps.labels, this.deps.userId));
      if (current.config.memberCatId !== catId) return;
      const floor = Math.max(
        this.floor,
        current.config.startedAfterSequence ?? 0,
        thread.watcher?.startedAfterSequence ?? 0,
      );
      const activationCut = `${current.config.activationRevision ?? 0}:${thread.watcher?.activationRevision ?? 0}`;
      if (
        !state.attempt &&
        !watcherRetirementPending(session) &&
        (state.afterSequence < floor || state.activationCut !== activationCut)
      ) {
        await saveWatcherState(this.deps.sessions, session.id, state, {
          afterSequence: Math.max(state.afterSequence, floor),
          activationCut,
          rawSince: Math.max(current.config.activatedAt ?? 0, thread.watcher?.activatedAt ?? 0),
          consumedThrough: undefined,
          messageOffset: undefined,
          backfillAfter: undefined,
        });
        continue;
      }
      const effective = effectiveWatcherState(current.config, thread, current.quietLabels);
      if (!effective.enabled || source.executionKind !== 'ordinary') {
        if (state.attempt || watcherRetirementPending(session)) return;
        await saveWatcherState(this.deps.sessions, session.id, state, { afterSequence: source.settledSequence! });
        continue;
      }
      const runService = await requireService();
      try {
        const prior = state.attempt ? await read(this.deps.executions.get(state.attempt.invocationId)) : null;
        const retirement = watcherRetirementPending(session);
        const recoveryOnly =
          retirement ||
          (!!state.attempt &&
            (watcherRecoveryFinalizationDue(state, this.deps.now?.() ?? Date.now()) ||
              state.activationCut !== activationCut ||
              (prior !== null && prior.status !== 'running')));
        if (
          state.attempt &&
          !retirement &&
          !(await reserveWatcherRecovery(
            this.deps,
            session,
            state,
            this.deps.now?.() ?? Date.now(),
            recoveryOnly ? `${current.config.revision}:${thread.watcher?.revision ?? 0}` : undefined,
          ))
        )
          return;
        await (this.deps.run ?? runWatcherInvocation)(this.deps, {
          session,
          source,
          service: runService,
          quiet: !effective.maySpeak,
          signal,
          recoveryOnly,
        });
        if (retirement) {
          const latest = await read(this.deps.sessions.getByChainKey(chainKey));
          // A parked/exhausted control probe is not progress. Poll reconciliation owns the next due probe.
          if (!latest || watcherRetirementPending(latest)) return;
        }
      } catch (error) {
        this.deps.report(error, threadId);
        const latest = await read(this.deps.sessions.get(session.id));
        const currentState = parseWatcherSessionState(latest?.watcherState);
        if (currentState.attempt || (latest && watcherRetirementPending(latest))) {
          this.retryThreads.add(threadId);
          return;
        }
        await recordWatcherSourceFailure(this.deps.executions, member.config.id, source, error);
        scan = source.settledSequence!;
      }
    }
    if (!signal.aborted) this.pending.add(threadId);
  }
}
