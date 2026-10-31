import { contextEpochScopeKey } from '../../../cats/services/session/context/ContextEpochOwner.js';
import type { LiveInboxScope } from '../inbox/live-inbox-contract.js';
import {
  type LiveRecoveryCursor,
  type LiveRecoveryOptions,
  type LiveRecoveryRequest,
  RECOVERY_DECISIONS_PER_PRODUCER,
  recoveryPage,
} from './live-recovery-contract.js';
import { RecoveryProjections } from './recovery-projections.js';
import { abortableRecoveryRead, recoveryBinding, recoveryContinuity } from './recovery-read-boundary.js';

const present = <T>(item: T | null): item is T => item !== null;

/** Stateless read composition. Host calls at a safe boundary and fences its final provider write. */
export class LiveRecoveryReader {
  constructor(private readonly options: LiveRecoveryOptions) {}

  read(input: LiveInboxScope, request: LiveRecoveryRequest) {
    return abortableRecoveryRead(request.signal, () => this.readCurrent(input, request));
  }

  private async readCurrent(input: LiveInboxScope, request: LiveRecoveryRequest) {
    const scope = Object.freeze({ ...input });
    const { signal } = request;
    const pageSize = request.pageSize ?? 8;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20) throw new Error('Invalid recovery page size');
    await this.check(scope, signal);
    const epochKey = contextEpochScopeKey(scope);
    const epoch = await this.options.epochs.get(epochKey);
    if (epoch && epoch.scopeKey !== epochKey) throw new Error('Recovery epoch scope mismatch');
    const binding = recoveryBinding(scope, epoch);
    const cursor = request.cursor ?? {
      binding,
      tasks: { complete: false },
      decisions: { complete: false },
      inbox: { complete: false },
    };
    if (cursor.binding !== binding) throw new Error('Stale recovery cursor; rebuild from canonical sources');
    const projection = new RecoveryProjections(this.options, scope);
    const [tasks, decisions, inbox] = await Promise.all([
      cursor.tasks.complete ? [] : this.options.tasks.listByThread(scope.threadId),
      cursor.decisions.complete
        ? []
        : this.options.approvals.listSettled(scope.userId, RECOVERY_DECISIONS_PER_PRODUCER),
      cursor.inbox.complete
        ? { items: [], hasMore: false, nextCursor: cursor.inbox.after }
        : this.options.inbox.page(scope, cursor.inbox.after, pageSize),
    ]);
    await this.check(scope, signal);
    const taskPage = recoveryPage(
      tasks.filter((task) => projection.eligibleTask(task)),
      (task) => task.id,
      cursor.tasks,
      pageSize,
    );
    const decisionPage = recoveryPage(
      decisions.filter((item) => projection.eligibleDecision(item)),
      (item) => `${String(item.decidedAt).padStart(16, '0')}:${item.sourceFeatureId}:${item.proposalId}`,
      cursor.decisions,
      pageSize,
    );
    const [taskItems, decisionItems, inboxItems] = await Promise.all([
      Promise.all(taskPage.items.map((task) => projection.task(task.id))),
      Promise.all(decisionPage.items.map((item) => projection.decision(item))),
      Promise.all(inbox.items.map((item) => this.options.inbox.read(scope, item.messageId))),
    ]);
    const currentEpoch = await this.options.epochs.get(epochKey);
    if (currentEpoch?.version !== epoch?.version || currentEpoch?.contextEpoch !== epoch?.contextEpoch)
      throw new Error('Recovery epoch changed during read; rebuild');
    await this.check(scope, signal);
    const next: LiveRecoveryCursor = {
      binding,
      tasks: taskPage.position,
      decisions: decisionPage.position,
      inbox: { after: inbox.nextCursor, complete: !inbox.hasMore },
    };
    return {
      coverage: 'source_backed_working_set' as const,
      authority: 'reference_data_only' as const,
      retention: 'unknown' as const,
      providerWindow: 'unknown' as const,
      scope,
      observedAt: Date.now(),
      continuity: recoveryContinuity(epoch),
      tasks: {
        coverage: 'current_thread_open_work' as const,
        items: taskItems.filter(present),
        hasMore: !next.tasks.complete,
      },
      summaries: {
        // Absence of a viewer-aware canonical reader is not evidence of an empty history.
        coverage: 'unavailable_viewer_evidence' as const,
        items: [],
      },
      decisions: {
        coverage: 'producer_bounded_history' as const,
        perProducerLimit: RECOVERY_DECISIONS_PER_PRODUCER,
        items: decisionItems.filter(present),
        hasMore: !next.decisions.complete,
      },
      inbox: {
        coverage: 'canonical_queue_references' as const,
        items: inboxItems.filter(present).filter((item) => !item.facts.handled),
        hasMore: !next.inbox.complete,
      },
      nextCursor: Object.values({
        tasks: next.tasks,
        decisions: next.decisions,
        inbox: next.inbox,
      }).some((position) => !position.complete)
        ? next
        : undefined,
    };
  }

  private async check(scope: LiveInboxScope, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!(await this.options.authorize(scope))) throw new Error('Recovery authority unavailable');
    signal.throwIfAborted();
  }
}
