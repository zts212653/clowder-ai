import {
  type TurnExecutionRecord,
  WATCHER_PANEL_DEFAULTS,
  type WatcherPanelMemberEntry,
  type WatcherPanelRound,
} from '@cat-cafe/shared';
import type { InvocationQueue } from '../../../cats/services/agents/invocation/InvocationQueue.js';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ILabelStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import type { IConciergeConfigStore } from '../../ConciergeConfigStore.js';
import { effectiveWatcherState, readWatcherPreferences } from '../watcher-controls.js';
import { watcherRoundMembers, watcherUsesOrdinaryContext } from '../watcher-routing.js';
import {
  shuffledWatcherPanelLabels,
  watcherPanelAlsoWorksHere,
  watcherPanelCitationValid,
  watcherPanelCutoffMessage,
  watcherPanelPrevious,
  wokenByWatcher,
} from './watcher-panel-facts.js';
import { type WatcherPanelLedger, watcherPanelRoundId } from './watcher-panel-ledger.js';
import { createWatcherPanelLog, type WatcherPanelLogger } from './watcher-panel-log.js';
import { runWatcherPanelMember, type WatcherPanelMemberOwners } from './watcher-panel-member.js';
import { loadWatcherPanelGuidance, type WatcherPanelGuidance } from './watcher-panel-prompt.js';
import { reconcileWatcherPanel, settleWatcherPanelDelivery } from './watcher-panel-settle.js';
import { WatcherPanelSlots } from './watcher-panel-slots.js';

export type WatcherPanelNudgeReceipt =
  | { accepted: true; delivered: false; deliveryAfterRound: boolean; reason?: 'quiet' }
  | { accepted: false; reason: 'not_current' | 'already_spoke' | 'citation_outside_material' };

export interface WatcherPanelRunnerDeps extends WatcherPanelMemberOwners {
  userId: string;
  configs: IConciergeConfigStore;
  labels: ILabelStore;
  ledger: WatcherPanelLedger;
  queue: Pick<InvocationQueue, 'enqueueExistingMessageDurable'>;
  publish(message: StoredMessage): void;
  report(error: unknown, threadId?: string): void;
  now?(): number;
  random?(): number;
  runMember?: typeof runWatcherPanelMember;
  loadGuidance?(): WatcherPanelGuidance;
  memberDeadlineMs?: number;
  log?: WatcherPanelLogger;
  family?(catId: string): string | undefined;
}

/** Turns that settled before a restart by more than this are history, not opportunities to speak now. */
const STALE_SOURCE_MS = 2 * 3_600_000;
const MEMBER_DEADLINE_MS = 15 * 60_000;

/**
 * F335 panel: every settled ordinary turn in a watched thread is one opportunity. All members judge the
 * same cutoff independently; their sentences are delivered once, anonymously. One round per thread at a
 * time; turns that settle meanwhile collapse into the newest, which the members then read through.
 */
export class WatcherPanelRunner {
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly waiting = new Map<string, TurnExecutionRecord>();
  /** Admitted member runs by invocation, so the nudge route finds the right ledger entry. */
  private readonly members = new Map<
    string,
    { round: WatcherPanelRound; entry: WatcherPanelMemberEntry; save(): Promise<void> }
  >();
  private capacity = WATCHER_PANEL_DEFAULTS.maxConcurrentRuns;
  private readonly slots = new WatcherPanelSlots(() => this.capacity);
  private stopped = false;
  private readonly log: ReturnType<typeof createWatcherPanelLog>;

  constructor(private readonly deps: WatcherPanelRunnerDeps) {
    this.log = createWatcherPanelLog(deps.log);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  offer(source: TurnExecutionRecord, floor: number): void {
    const settledAt = source.responseSettlement?.settledAt;
    if (
      this.stopped ||
      source.executionKind !== 'ordinary' ||
      settledAt === undefined ||
      source.settledSequence === undefined ||
      source.settledSequence <= floor ||
      this.now() - settledAt > STALE_SOURCE_MS
    )
      return;
    const threadId = source.threadId;
    if (!this.active.has(threadId)) {
      this.start(threadId, source);
      return;
    }
    const queued = this.waiting.get(threadId);
    if (queued && queued.settledSequence! >= source.settledSequence) return;
    this.waiting.set(threadId, source);
    if (queued) void this.recordCoalesced(queued, source).catch((error) => this.deps.report(error, threadId));
  }

  controlChanged(threadId?: string): void {
    void (async () => {
      const preferences = await readWatcherPreferences(this.deps.configs, this.deps.labels, this.deps.userId);
      for (const [id, run] of this.active) {
        if (threadId && id !== threadId) continue;
        const thread = await this.deps.threads.get(id);
        if (
          !threadId ||
          !watcherUsesOrdinaryContext(preferences.config) ||
          !thread ||
          thread.deletedAt ||
          !effectiveWatcherState(preferences.config, thread, preferences.quietLabels).enabled
        )
          run.abort.abort(new Error('watcher_disabled'));
      }
    })().catch((error) => this.deps.report(error, threadId));
  }

  /** A restart ends every in-flight round honestly; nothing is replayed or delivered late. */
  reconcile(): Promise<void> {
    return reconcileWatcherPanel(this.deps, this.now(), new Set(this.active.keys()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.waiting.clear();
    for (const run of this.active.values()) run.abort.abort(new Error('watcher_supervisor_stopped'));
    await this.idle();
  }

  /** Resolves when no round is running or waiting. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()].map((run) => run.promise));
  }

  private start(threadId: string, source: TurnExecutionRecord): void {
    const abort = new AbortController();
    const promise = this.round(source, abort.signal)
      .catch((err) => {
        this.log.failed(source, err);
        this.deps.report(err, threadId);
      })
      .finally(() => {
        this.active.delete(threadId);
        const next = this.waiting.get(threadId);
        this.waiting.delete(threadId);
        if (next && !this.stopped) this.start(threadId, next);
      });
    this.active.set(threadId, { abort, promise });
  }

  private async recordCoalesced(source: TurnExecutionRecord, into: TurnExecutionRecord): Promise<void> {
    const roundId = watcherPanelRoundId(source.invocationId);
    const cutoff = await watcherPanelCutoffMessage(this.deps.messages, source);
    if (!cutoff || (await this.deps.ledger.get(roundId))) return;
    const now = this.now();
    await this.deps.ledger.save({
      v: 1,
      roundId,
      userId: source.userId,
      threadId: source.threadId,
      sourceInvocationId: source.invocationId,
      sourceSettledSequence: source.settledSequence!,
      workerCatId: source.catId,
      cutoffMessageId: cutoff.id,
      createdAt: now,
      updatedAt: now,
      status: 'coalesced',
      guidanceDigest: '',
      members: [],
      coalescedInto: watcherPanelRoundId(into.invocationId),
    });
  }

  private async round(source: TurnExecutionRecord, signal: AbortSignal): Promise<void> {
    const deps = this.deps;
    const roundId = watcherPanelRoundId(source.invocationId);
    if (await deps.ledger.get(roundId)) return;
    const preferences = await readWatcherPreferences(deps.configs, deps.labels, deps.userId);
    const panel = preferences.config.panel;
    if (!watcherUsesOrdinaryContext(preferences.config)) return;
    this.capacity =
      preferences.config.routing?.maxConcurrentRuns ??
      panel?.maxConcurrentRuns ??
      WATCHER_PANEL_DEFAULTS.maxConcurrentRuns;
    const thread = await deps.threads.get(source.threadId);
    if (!thread || thread.deletedAt || (thread.watcher?.startedAfterSequence ?? 0) >= source.settledSequence!) return;
    const effective = effectiveWatcherState(preferences.config, thread, preferences.quietLabels, this.now());
    if (!effective.enabled) return;
    const cutoff = await watcherPanelCutoffMessage(deps.messages, source);
    if (!cutoff) return;
    const selected = watcherRoundMembers(preferences.config, source.catId, deps.family);
    const skip = (await wokenByWatcher(deps.messages, source)) ? 'woken_by_watcher' : selected.skipped;
    if (skip) {
      const now = this.now();
      const skipped: WatcherPanelRound = {
        v: 1,
        roundId,
        userId: source.userId,
        threadId: source.threadId,
        sourceInvocationId: source.invocationId,
        sourceSettledSequence: source.settledSequence!,
        configRevision: preferences.config.revision,
        workerCatId: source.catId,
        cutoffMessageId: cutoff.id,
        cutoffAt: source.responseSettlement!.settledAt,
        createdAt: now,
        updatedAt: now,
        status: 'completed',
        quiet: skip,
        guidanceDigest: '',
        members: [],
        delivery: { skipped: 'quiet' },
      };
      await deps.ledger.save(skipped);
      this.log.skipped(skipped);
      return;
    }
    const quiet = effective.pausedUntil
      ? ('paused' as const)
      : effective.labelMuted
        ? ('label_muted' as const)
        : undefined;
    const guidance = (deps.loadGuidance ?? loadWatcherPanelGuidance)();
    const labels = shuffledWatcherPanelLabels(selected.members.length, deps.random);
    const cutoffAt = source.responseSettlement!.settledAt;
    const worksHere = await Promise.all(
      selected.members.map((member) => watcherPanelAlsoWorksHere(deps.sessions, source, member.catId)),
    );
    const createdAt = this.now();
    const round: WatcherPanelRound = {
      v: 1,
      roundId,
      userId: source.userId,
      threadId: source.threadId,
      sourceInvocationId: source.invocationId,
      sourceSettledSequence: source.settledSequence!,
      workerCatId: source.catId,
      cutoffMessageId: cutoff.id,
      cutoffAt,
      configRevision: preferences.config.revision,
      createdAt,
      updatedAt: createdAt,
      status: 'running',
      ...(quiet ? { quiet } : {}),
      guidanceDigest: guidance.digest,
      members: selected.members.map((member, index) => ({
        catId: member.catId,
        label: labels[index]!,
        status: 'pending' as const,
        ...(worksHere[index] ? { alsoWorksHere: worksHere[index] } : {}),
        ...(member.accountRef ? { accountRef: member.accountRef } : {}),
      })),
    };
    let saving = deps.ledger.save(round);
    const save = () => (saving = saving.then(() => deps.ledger.save({ ...round, updatedAt: this.now() })));
    await saving;
    this.log.started(round);
    const admitted: string[] = [];
    await Promise.all(
      round.members.map(async (entry, index) => {
        const member = selected.members[index]!;
        let release: (() => void) | undefined;
        try {
          release = await this.slots.acquire(signal);
          Object.assign(entry, { status: 'running', startedAt: this.now() });
          await save();
          const previous = await watcherPanelPrevious(deps, source, member.catId, roundId);
          const result = await (deps.runMember ?? runWatcherPanelMember)(deps, {
            round: { ...round, cutoffAt },
            source,
            cutoff,
            ...(thread.title ? { threadTitle: thread.title } : {}),
            catId: member.catId,
            ...(member.accountRef ? { accountRef: member.accountRef } : {}),
            guidance,
            ...(previous ? { previous } : {}),
            onAdmitted: (invocationId) => {
              admitted.push(invocationId);
              this.members.set(invocationId, { round, entry, save });
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(deps.memberDeadlineMs ?? MEMBER_DEADLINE_MS)]),
          });
          // A sentence handed in before a late failure still stands; it was said.
          Object.assign(entry, result, { status: entry.sentence ? 'spoke' : result.status, endedAt: this.now() });
        } catch (error) {
          Object.assign(entry, {
            status: signal.aborted ? 'interrupted' : 'failed',
            failure: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            endedAt: this.now(),
          });
        } finally {
          release?.();
        }
        this.log.memberFailed(round, entry);
        await save();
      }),
    );
    for (const invocationId of admitted) this.members.delete(invocationId);
    round.status = signal.aborted ? 'interrupted' : 'completed';
    round.delivery = await settleWatcherPanelDelivery(this.deps, round, source, signal.aborted, this.now());
    await save();
    this.log.finished(round, this.now());
  }

  /**
   * cat_cafe_watcher_nudge from a panel member: the sentence is held on this round's ledger and delivered
   * with the others once every member has finished. One sentence per member per round.
   */
  async acceptNudge(input: {
    invocationId: string;
    userId: string;
    threadId: string;
    sentence: string;
    sourceMessageId: string;
  }): Promise<WatcherPanelNudgeReceipt> {
    const member = this.members.get(input.invocationId);
    if (!member || member.round.userId !== input.userId || member.round.threadId !== input.threadId)
      return { accepted: false, reason: 'not_current' };
    if (member.entry.sentence) return { accepted: false, reason: 'already_spoke' };
    if (
      !(await watcherPanelCitationValid(
        this.deps.messages,
        input.threadId,
        member.round.cutoffAt!,
        input.sourceMessageId,
      ))
    )
      return { accepted: false, reason: 'citation_outside_material' };
    Object.assign(member.entry, { sentence: input.sentence, citationMessageId: input.sourceMessageId });
    await member.save();
    return member.round.quiet
      ? { accepted: true, delivered: false, deliveryAfterRound: false, reason: 'quiet' }
      : { accepted: true, delivered: false, deliveryAfterRound: true };
  }

  /** Proposals and desk deliveries follow the same voice as a sentence: only a current, non-quiet round. */
  async maySpeak(invocationId: string): Promise<boolean> {
    const member = this.members.get(invocationId);
    if (!member || member.round.quiet || member.round.status !== 'running') return false;
    const [preferences, thread] = await Promise.all([
      readWatcherPreferences(this.deps.configs, this.deps.labels, this.deps.userId),
      this.deps.threads.get(member.round.threadId),
    ]);
    return Boolean(
      (member.round.configRevision === undefined || member.round.configRevision === preferences.config.revision) &&
        watcherUsesOrdinaryContext(preferences.config) &&
        thread &&
        !thread.deletedAt &&
        effectiveWatcherState(preferences.config, thread, preferences.quietLabels, this.now()).maySpeak,
    );
  }
}
