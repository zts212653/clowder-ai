import type { RoutingSignalEventV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';

export type RoutingSignalEventAppendOutcome = 'appended' | 'replayed';

export interface RoutingSignalEventAppendResult {
  outcome: RoutingSignalEventAppendOutcome;
  event: RoutingSignalEventV1;
}

export interface IRoutingSignalEventStore {
  append(event: RoutingSignalEventV1): Promise<RoutingSignalEventAppendResult>;
  get(ownerId: string, eventId: string): Promise<RoutingSignalEventV1 | null>;
  getByCommand(ownerId: string, commandId: string): Promise<RoutingSignalEventV1 | null>;
  getOwnerRevision(ownerId: string): Promise<number>;
  listByOwner(ownerId: string): Promise<RoutingSignalEventV1[]>;
  listBySubject(ownerId: string, subjectRef: RoutingSubjectRefV1): Promise<RoutingSignalEventV1[]>;
}

export class RoutingSignalEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingSignalEventConflictError';
  }
}

export class RoutingSignalEventHydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingSignalEventHydrationError';
  }
}
