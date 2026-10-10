export interface CallerDispatchObservationPointer {
  readonly ownerId: string;
  readonly threadId: string;
  readonly callerCatId: string;
  readonly sourceMessageId: string;
  readonly targetId: string;
  readonly revision: number;
  readonly presentedRevision: number;
  readonly firstAddedBy: 'initial' | 'steer' | 'unknown';
  readonly selectionChange: 'added' | 'removed';
  readonly selectionChangedBy: 'initial' | 'steer' | 'queue_withdrawal' | 'unknown';
}

export interface CallerDispatchObservationInclusion {
  readonly key: string;
  /** Revision frozen before the asynchronous History read that produced this prompt line. */
  readonly includedRevision: number;
  readonly fingerprint: string;
  readonly terminal: boolean;
}

export interface CallerDispatchObservationProjection {
  readonly prompt: string;
  /** Only facts actually retained in the final prompt may be acknowledged on success. */
  readonly included: readonly CallerDispatchObservationInclusion[];
  readonly truncated: boolean;
}

export interface CallerDispatchProcessStartProjection {
  readonly prompt: string;
}

export type CallerDispatchObservationScope = Pick<
  CallerDispatchObservationPointer,
  'ownerId' | 'threadId' | 'callerCatId'
>;

export interface ObservationLine {
  line: string;
  terminal: boolean;
  fingerprint: string;
}

export function callerDispatchObservationSlotKey(pointer: CallerDispatchObservationScope): string {
  return JSON.stringify([pointer.ownerId, pointer.threadId, pointer.callerCatId]);
}

export function callerDispatchObservationKey(
  pointer: Pick<
    CallerDispatchObservationPointer,
    'ownerId' | 'threadId' | 'callerCatId' | 'sourceMessageId' | 'targetId'
  >,
): string {
  return JSON.stringify([
    pointer.ownerId,
    pointer.threadId,
    pointer.callerCatId,
    pointer.sourceMessageId,
    pointer.targetId,
  ]);
}
