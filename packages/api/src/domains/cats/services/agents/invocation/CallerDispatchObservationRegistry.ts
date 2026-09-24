import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import {
  type CallerDispatchObservationEntry,
  CallerDispatchObservationIndex,
} from './CallerDispatchObservationIndex.js';
import { CallerDispatchProcessStartRegistry } from './CallerDispatchProcessStartRegistry.js';
import {
  type CallerDispatchObservationInclusion,
  type CallerDispatchObservationPointer,
  type CallerDispatchObservationProjection,
  type CallerDispatchObservationScope,
  type CallerDispatchProcessStartProjection,
  callerDispatchObservationKey,
  callerDispatchObservationSlotKey,
} from './caller-dispatch-observation-model.js';
import {
  type ProjectedObservation,
  projectCallerDispatchObservations,
} from './caller-dispatch-observation-projector.js';
import { readCallerDispatchObservationLine } from './caller-dispatch-observation-reader.js';

export {
  type CallerDispatchObservationInclusion,
  type CallerDispatchObservationPointer,
  type CallerDispatchObservationProjection,
  type CallerDispatchProcessStartProjection,
  callerDispatchObservationKey,
} from './caller-dispatch-observation-model.js';

const DEFAULT_MAX_PROMPT_CHARS = 6_000;

/**
 * Process-local index only. Canonical phase/outcome always comes from History.
 * Re-registering the same exact source×target is intentionally idempotent.
 */
export class CallerDispatchObservationRegistry {
  private readonly observations = new CallerDispatchObservationIndex();
  private readonly processStart = new CallerDispatchProcessStartRegistry();
  private nextRevision = 0;

  private allocateRevision(): number {
    this.nextRevision += 1;
    return this.nextRevision;
  }

  private registerSelection(
    pointer: Omit<
      CallerDispatchObservationPointer,
      'revision' | 'presentedRevision' | 'firstAddedBy' | 'selectionChange' | 'selectionChangedBy'
    >,
    change: 'added' | 'removed',
    changedBy: 'initial' | 'steer' | 'queue_withdrawal' | 'unknown',
  ): string {
    const sk = callerDispatchObservationSlotKey(pointer);
    const now = Date.now();
    const key = callerDispatchObservationKey(pointer);
    const current = this.observations.get(sk, key);
    if (current?.selectionChange === change && current.selectionChangedBy === changedBy) return key;
    const next: CallerDispatchObservationEntry = {
      ...pointer,
      revision: this.allocateRevision(),
      presentedRevision: current?.presentedRevision ?? 0,
      firstAddedBy:
        current?.firstAddedBy ??
        (change === 'added' && (changedBy === 'initial' || changedBy === 'steer') ? changedBy : 'unknown'),
      selectionChange: change,
      selectionChangedBy: changedBy,
      touchedAt: now,
      ...(current?.presentedFingerprint ? { presentedFingerprint: current.presentedFingerprint } : {}),
      ...(current?.observedFingerprint ? { observedFingerprint: current.observedFingerprint } : {}),
      ...(current?.actualFingerprint ? { actualFingerprint: current.actualFingerprint } : {}),
    };
    this.observations.set(sk, key, next);
    return key;
  }

  private registerActualRef(
    pointer: Omit<CallerDispatchObservationPointer, 'revision' | 'presentedRevision'>,
    actualFingerprint: string,
  ): string {
    const sk = callerDispatchObservationSlotKey(pointer);
    const now = Date.now();
    const key = callerDispatchObservationKey(pointer);
    const current = this.observations.get(sk, key);
    if (current?.actualFingerprint === actualFingerprint) return key;

    const next: CallerDispatchObservationEntry = {
      ...pointer,
      revision: this.allocateRevision(),
      presentedRevision: current?.presentedRevision ?? 0,
      firstAddedBy: current?.firstAddedBy ?? pointer.firstAddedBy,
      selectionChange: current?.selectionChange ?? pointer.selectionChange,
      selectionChangedBy: current?.selectionChangedBy ?? pointer.selectionChangedBy,
      actualFingerprint,
      touchedAt: now,
      ...(current?.presentedFingerprint ? { presentedFingerprint: current.presentedFingerprint } : {}),
      ...(current?.observedFingerprint ? { observedFingerprint: current.observedFingerprint } : {}),
    };
    this.observations.set(sk, key, next);
    return key;
  }

  registerInitialSource(source: StoredMessage, targetIds: readonly string[]): string[] {
    const from = messageFrom(source);
    if (from.kind !== 'agent') return [];
    return [...new Set(targetIds)].map((targetId) =>
      this.registerSelection(
        {
          ownerId: source.userId,
          threadId: source.threadId,
          callerCatId: from.catId,
          sourceMessageId: source.id,
          targetId,
        },
        'added',
        'initial',
      ),
    );
  }

  registerSteerChanges(
    source: StoredMessage,
    changes: { readonly addedTargetIds: readonly string[]; readonly removedTargetIds: readonly string[] },
  ): string[] {
    const from = messageFrom(source);
    if (from.kind !== 'agent') return [];
    return this.registerSteerChangesByIdentity(
      {
        ownerId: source.userId,
        threadId: source.threadId,
        callerCatId: from.catId,
        sourceMessageId: source.id,
      },
      changes,
    );
  }

  registerSteerChangesByIdentity(
    source: {
      readonly ownerId: string;
      readonly threadId: string;
      readonly callerCatId: string;
      readonly sourceMessageId: string;
    },
    changes: { readonly addedTargetIds: readonly string[]; readonly removedTargetIds: readonly string[] },
  ): string[] {
    const registered: string[] = [];
    for (const targetId of new Set(changes.addedTargetIds)) {
      registered.push(
        this.registerSelection(
          {
            ownerId: source.ownerId,
            threadId: source.threadId,
            callerCatId: source.callerCatId,
            sourceMessageId: source.sourceMessageId,
            targetId,
          },
          'added',
          'steer',
        ),
      );
    }
    for (const targetId of new Set(changes.removedTargetIds)) {
      registered.push(
        this.registerSelection(
          {
            ownerId: source.ownerId,
            threadId: source.threadId,
            callerCatId: source.callerCatId,
            sourceMessageId: source.sourceMessageId,
            targetId,
          },
          'removed',
          'steer',
        ),
      );
    }
    return registered;
  }

  registerQueueWithdrawalByIdentity(source: {
    readonly ownerId: string;
    readonly threadId: string;
    readonly callerCatId: string;
    readonly sourceMessageId: string;
    readonly targetIds: readonly string[];
  }): string[] {
    return [...new Set(source.targetIds)].map((targetId) =>
      this.registerSelection(
        {
          ownerId: source.ownerId,
          threadId: source.threadId,
          callerCatId: source.callerCatId,
          sourceMessageId: source.sourceMessageId,
          targetId,
        },
        'removed',
        'queue_withdrawal',
      ),
    );
  }

  registerPersistedSource(source: StoredMessage, targetIds?: readonly string[]): string[] {
    const from = messageFrom(source);
    if (from.kind !== 'agent') return [];
    if (source.lifecycle?.kind !== 'input' && source.lifecycle?.kind !== 'response') return [];
    const allowedTargets = targetIds ? new Set(targetIds) : undefined;
    return (source.lifecycle.dispatchRefs ?? [])
      .filter((ref) => !allowedTargets || allowedTargets.has(ref.targetId))
      .map((ref) =>
        this.registerActualRef(
          {
            ownerId: source.userId,
            threadId: source.threadId,
            callerCatId: from.catId,
            sourceMessageId: source.id,
            targetId: ref.targetId,
            firstAddedBy: 'unknown',
            selectionChange: 'added',
            selectionChangedBy: 'unknown',
          },
          `${ref.phase}:${ref.statusMessageId}`,
        ),
      );
  }

  list(scope: CallerDispatchObservationScope): readonly CallerDispatchObservationPointer[] {
    return this.observations.list(callerDispatchObservationSlotKey(scope));
  }

  acknowledge(included: readonly CallerDispatchObservationInclusion[]): void {
    this.observations.acknowledge(included);
  }

  projectProcessStartNotice(
    scope: CallerDispatchObservationScope,
    processGenerationId: string,
  ): CallerDispatchProcessStartProjection {
    return this.processStart.project(scope, processGenerationId);
  }

  acknowledgeProcessStartNotice(scope: CallerDispatchObservationScope, processGenerationId: string): void {
    this.processStart.acknowledge(scope, processGenerationId);
  }

  private async refreshPointer(
    messageStore: Pick<IMessageStore, 'getById'>,
    pointer: CallerDispatchObservationPointer,
  ): Promise<ProjectedObservation | null> {
    const key = callerDispatchObservationKey(pointer);
    const includedRevision = pointer.revision;
    const observation = await readCallerDispatchObservationLine(messageStore, pointer);
    const slotKey = callerDispatchObservationSlotKey(pointer);
    let current = this.observations.get(slotKey, key);
    // A committed Steer/update won the race while History was being read.
    // Do not relabel the stale line with the newer revision; retain it for the next turn.
    if (!current || current.revision !== includedRevision) return null;

    if (current.observedFingerprint !== observation.fingerprint) {
      const projectedRevision =
        current.presentedRevision >= current.revision ? this.allocateRevision() : current.revision;
      current = {
        ...current,
        revision: projectedRevision,
        observedFingerprint: observation.fingerprint,
        touchedAt: Date.now(),
      };
      this.observations.set(slotKey, key, current);
    }
    const alreadyPresented =
      current.presentedRevision === current.revision && current.presentedFingerprint === observation.fingerprint;
    if (alreadyPresented) return null;
    return { ...observation, key, includedRevision: current.revision };
  }

  async project(
    messageStore: Pick<IMessageStore, 'getById'>,
    scope: CallerDispatchObservationScope,
    maxPromptChars = DEFAULT_MAX_PROMPT_CHARS,
  ): Promise<CallerDispatchObservationProjection> {
    const allPointers = this.list(scope);
    return projectCallerDispatchObservations({
      allPointers,
      maxPromptChars,
      refresh: (pointer) => this.refreshPointer(messageStore, pointer),
    });
  }
}
