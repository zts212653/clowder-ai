import type {
  BindCoveredMessageIdsResult,
  CreateTurnExecutionInput,
  CreateTurnExecutionResult,
  InterruptRunningTurnExecutionsInput,
  ITurnExecutionStore,
  TransitionTurnExecutionResult,
  TurnExecutionRecord,
  TurnExecutionTerminalInput,
} from '../../stores/ports/TurnExecutionStore.js';
import {
  authTerminalFromTurnExecution,
  callbackAuthDispositionFromTurnExecution,
} from './CallbackAuthTurnExecutionProjection.js';
import type { AuthTerminalCommitResult, InvocationRecord, InvocationRegistry } from './InvocationRegistry.js';

export interface CallbackAuthStartupReconcileResult {
  migration: Awaited<ReturnType<InvocationRegistry['migrateLegacyRecords']>>;
  repairedCanonicalTerminals: number;
  revokedUnadmittedOrphans: number;
  conflicts: number;
}

/**
 * Callback-auth architecture cell coordinator.
 *
 * The wrapped TurnExecution store remains canonical. Terminal transitions are
 * committed there first and only then projected into callback-auth. Verify and
 * startup reconciliation repair the deliberately tolerated crash window.
 */
export class CallbackAuthTurnExecutionLifecycle implements ITurnExecutionStore {
  constructor(
    private readonly store: ITurnExecutionStore,
    private readonly registry: InvocationRegistry,
  ) {}

  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult | Promise<CreateTurnExecutionResult> {
    return this.store.createRunning(input);
  }

  bindCoveredMessageIds(
    invocationId: string,
    messageIds: readonly string[],
  ): BindCoveredMessageIdsResult | Promise<BindCoveredMessageIdsResult> {
    return this.store.bindCoveredMessageIds(invocationId, messageIds);
  }

  get(invocationId: string): TurnExecutionRecord | null | Promise<TurnExecutionRecord | null> {
    return this.store.get(invocationId);
  }

  listByParent(parentInvocationId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]> {
    return this.store.listByParent(parentInvocationId);
  }

  listRunningByUser(userId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]> {
    return this.store.listRunningByUser(userId);
  }

  async transitionTerminal(
    invocationId: string,
    input: TurnExecutionTerminalInput,
  ): Promise<TransitionTurnExecutionResult> {
    const canonical = await this.store.transitionTerminal(invocationId, input);
    if (canonical.record && canonical.record.status !== 'running') {
      await this.registry.commitTerminal(authTerminalFromTurnExecution(canonical.record));
    }
    return canonical;
  }

  async interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): Promise<TurnExecutionRecord[]> {
    const interrupted = await this.store.interruptRunningBefore(cutoffStartedAt, input);
    for (const record of interrupted) {
      await this.registry.commitTerminal(authTerminalFromTurnExecution(record));
    }
    return interrupted;
  }

  async failRegistration(invocationId: string, endedAt: number, reason: string): Promise<AuthTerminalCommitResult> {
    return this.registry.commitTerminal({
      invocationId,
      disposition: 'failed',
      endedAt,
      endReason: reason,
    });
  }

  async reconcileStartup(input: { processStartedAt: number }): Promise<CallbackAuthStartupReconcileResult> {
    const migration = await this.registry.migrateLegacyRecords();
    let repairedCanonicalTerminals = 0;
    let revokedUnadmittedOrphans = 0;
    let conflicts = 0;

    for (const authRecord of await this.registry.listActiveRecords()) {
      const outcome = await this.reconcileActiveRecord(authRecord, input.processStartedAt);
      if (outcome === 'repaired') repairedCanonicalTerminals += 1;
      if (outcome === 'revoked') revokedUnadmittedOrphans += 1;
      if (outcome === 'conflict') conflicts += 1;
    }

    return { migration, repairedCanonicalTerminals, revokedUnadmittedOrphans, conflicts };
  }

  private async reconcileActiveRecord(
    authRecord: InvocationRecord,
    processStartedAt: number,
  ): Promise<'unchanged' | 'repaired' | 'revoked' | 'conflict'> {
    const canonical = await this.store.get(authRecord.invocationId);
    if (!canonical) {
      if (authRecord.createdAt >= processStartedAt) return 'unchanged';
      const commit = await this.registry.commitTerminal({
        invocationId: authRecord.invocationId,
        disposition: 'revoked',
        endedAt: Date.now(),
        endReason: 'unadmitted_orphan',
      });
      return commit.outcome === 'committed' ? 'revoked' : 'unchanged';
    }
    if (canonical.status === 'running') return 'unchanged';
    const disposition = callbackAuthDispositionFromTurnExecution(canonical);
    const commit = await this.registry.commitTerminal(authTerminalFromTurnExecution(canonical));
    if (commit.outcome === 'committed') return 'repaired';
    if (commit.outcome === 'already_terminal' && commit.record.state !== disposition) return 'conflict';
    return 'unchanged';
  }
}
