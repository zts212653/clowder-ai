import type {
  MemoryOwnerActionError,
  MemoryOwnerActionOutcome,
  MemoryOwnerActionReceipt,
  TasteMemoryCorrectionPatch,
  TasteMemoryOwnerAction,
} from '@cat-cafe/shared';
import type { SessionMutex } from '../../cats/services/agents/invocation/SessionMutex.js';
import type { OwnerMemoryActionCoordinator } from '../owner/OwnerMemoryActionCoordinator.js';
import type { TasteMemoryLifecycleStore, TasteOwnerActionEvidence } from './TasteMemoryLifecycleStore.js';
import {
  isTastePublicationIndeterminateError,
  TasteMemoryMutationError,
  type TasteMemoryProjectionResult,
  type TasteMemoryProjectionWriter,
} from './TasteMemoryProjectionWriter.js';
import { tasteMemoryId } from './taste-memory-identity.js';

export class TasteMemoryLifecycleService {
  constructor(
    private readonly deps: {
      store: TasteMemoryLifecycleStore;
      writer: TasteMemoryProjectionWriter;
      coordinator: OwnerMemoryActionCoordinator;
      targetLock: SessionMutex;
      lockKey: () => string;
      invalidateDerived: (input: { ownerUserId: string; sourcePath: string }) => Promise<void>;
    },
  ) {}

  async executeOwnerAction(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
  ): Promise<MemoryOwnerActionReceipt | { error: MemoryOwnerActionError }> {
    // Every Taste mutation takes the repository lock before the receipt lock.
    // Approval corrections already hold this lock and follow the same order,
    // preventing direct-action ↔ approval lock inversion.
    const release = await this.deps.targetLock.acquire(this.deps.lockKey());
    try {
      return await this.executeCoordinated(ownerUserId, memoryId, sourcePath, command);
    } finally {
      release();
    }
  }

  /** Called only by the Taste approval pipeline, which already owns targetLock/lockKey. */
  applyApprovedCorrectionUnderTargetLock(input: {
    ownerUserId: string;
    sourcePath: string;
    expectedRevision: string;
    patch: TasteMemoryCorrectionPatch;
    requestId: string;
  }) {
    const memoryId = tasteMemoryId(input.sourcePath);
    const command: TasteMemoryOwnerAction = {
      action: 'correct',
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      patch: input.patch,
    };
    return this.executeCoordinated(input.ownerUserId, memoryId, input.sourcePath, command);
  }

  private executeCoordinated(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
  ) {
    return this.deps.coordinator.execute(
      { ownerUserId, lane: 'taste', memoryId, requestId: command.requestId, command },
      {
        recover: () => this.recover(ownerUserId, memoryId, sourcePath, command),
        run: () => this.runInsideTargetLock(ownerUserId, memoryId, sourcePath, command),
      },
    );
  }

  private async runInsideTargetLock(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
  ) {
    const commandDigest = this.deps.store.commandDigest(command);
    let evidence = this.deps.store.getOwnerActionEvidence(ownerUserId, sourcePath, command.requestId);
    if (evidence && evidence.commandDigest !== commandDigest) return rejected('idempotency_conflict');
    if (evidence?.applied) return this.appliedEvidence(ownerUserId, memoryId, sourcePath, command, evidence);
    if (!evidence) {
      const prepared = await this.prepareEvidence(ownerUserId, memoryId, sourcePath, command);
      if ('error' in prepared) return rejected(prepared.error);
      evidence = prepared;
    }
    return this.applyPrepared(ownerUserId, memoryId, sourcePath, command, commandDigest, evidence);
  }

  private async appliedEvidence(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
    evidence: TasteOwnerActionEvidence,
  ) {
    await this.deps.invalidateDerived({ ownerUserId, sourcePath });
    if (command.action === 'hard_forget') {
      return { status: 'applied' as const, receipt: forgottenReceipt(memoryId) };
    }
    if (!evidence.revision || !evidence.status) throw new Error('Applied Taste action evidence is incomplete');
    return {
      status: 'applied' as const,
      receipt: projectReceipt(memoryId, command.action, evidence.revision, evidence.status),
    };
  }

  private async prepareEvidence(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
  ): Promise<TasteOwnerActionEvidence | { error: MemoryOwnerActionError }> {
    let current: Awaited<ReturnType<TasteMemoryProjectionWriter['readCurrent']>>;
    try {
      current = await this.deps.writer.readCurrent(sourcePath);
    } catch (error) {
      if (error instanceof TasteMemoryMutationError) return { error: error.code };
      throw error;
    }
    if (!current) return { error: 'not_available' };
    if (current.revision !== command.expectedRevision) return { error: 'stale_revision' };
    if (command.action !== 'hard_forget' && current.status !== 'active') return { error: 'not_available' };
    if (
      command.action === 'confirm_takeaway' &&
      !this.hasCandidate(ownerUserId, sourcePath, current.revision, command)
    ) {
      return { error: 'candidate_unavailable' };
    }
    return this.deps.store.prepareAction({
      ownerUserId,
      sourcePath,
      memoryId,
      command,
      currentStatus: current.status,
      currentRevision: current.revision,
    });
  }

  private hasCandidate(
    ownerUserId: string,
    sourcePath: string,
    currentRevision: string,
    command: Extract<TasteMemoryOwnerAction, { action: 'confirm_takeaway' }>,
  ): boolean {
    const candidate = this.deps.store.candidateFor(ownerUserId, sourcePath, currentRevision);
    return candidate?.candidateRevision === command.candidateRevision;
  }

  private async applyPrepared(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
    commandDigest: string,
    evidence: TasteOwnerActionEvidence,
  ) {
    let projection: TasteMemoryProjectionResult;
    try {
      projection = await this.deps.writer.apply({
        ownerUserId,
        sourcePath,
        command,
        ...(evidence.revision ? { knownTargetRevision: evidence.revision } : {}),
        recordTargetRevision: (revision) =>
          this.deps.store.recordTargetRevision({
            ownerUserId,
            sourcePath,
            requestId: command.requestId,
            commandDigest,
            targetRevision: revision,
          }),
      });
    } catch (error) {
      if (isTastePublicationIndeterminateError(error)) throw error;
      this.deps.store.rollbackPrepared(ownerUserId, sourcePath, command.requestId, commandDigest);
      if (error instanceof TasteMemoryMutationError) return rejected(error.code);
      throw error;
    }
    this.deps.store.completeAction({
      ownerUserId,
      sourcePath,
      memoryId,
      command,
      resultRevision: projection.revision,
      resultStatus: projection.status,
    });
    const receipt = projectReceipt(memoryId, command.action, projection.revision, projection.status);
    await this.deps.invalidateDerived({ ownerUserId, sourcePath });
    return { status: 'applied' as const, receipt };
  }

  private async recover(
    ownerUserId: string,
    memoryId: string,
    sourcePath: string,
    command: TasteMemoryOwnerAction,
  ): Promise<(Omit<MemoryOwnerActionReceipt, 'outcome'> & { outcome?: MemoryOwnerActionOutcome }) | null> {
    const evidence = this.deps.store.getOwnerActionEvidence(ownerUserId, sourcePath, command.requestId);
    if (
      !evidence?.applied ||
      evidence.action !== command.action ||
      evidence.commandDigest !== this.deps.store.commandDigest(command)
    ) {
      return null;
    }
    await this.deps.invalidateDerived({ ownerUserId, sourcePath });
    if (command.action === 'hard_forget') return forgottenReceipt(memoryId);
    if (!evidence.revision || !evidence.status) return null;
    return projectReceipt(memoryId, command.action, evidence.revision, evidence.status);
  }
}

function projectReceipt(
  memoryId: string,
  action: TasteMemoryOwnerAction['action'],
  revision: string | null,
  status: 'active' | 'retired' | 'forgotten',
): Omit<MemoryOwnerActionReceipt, 'outcome'> & { outcome?: MemoryOwnerActionOutcome } {
  if (action === 'hard_forget' || status === 'forgotten') return forgottenReceipt(memoryId);
  if (!revision) throw new Error(`Taste ${action} completed without a revision`);
  return { action, memoryId, revision, status };
}

function forgottenReceipt(memoryId: string): Omit<MemoryOwnerActionReceipt, 'outcome'> {
  return {
    action: 'hard_forget',
    memoryId,
    forgetScope: {
      canonicalMemory: 'deleted',
      derivedProjections: 'invalidated',
      originalSource: 'preserved',
      immutableAudit: 'retained',
    },
  };
}

function rejected(error: MemoryOwnerActionError) {
  return { status: 'rejected' as const, error };
}
