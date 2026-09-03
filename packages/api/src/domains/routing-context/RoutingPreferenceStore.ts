import type { RoutingPreferenceRevisionV1 } from '@cat-cafe/shared';

export interface RoutingPreferenceAppendResult {
  outcome: 'appended' | 'replayed';
  revision: RoutingPreferenceRevisionV1;
}

export interface IRoutingPreferenceStore {
  append(revision: RoutingPreferenceRevisionV1): Promise<RoutingPreferenceAppendResult>;
  getRevision(ownerId: string, revisionId: string): Promise<RoutingPreferenceRevisionV1 | null>;
  getByCommand(ownerId: string, commandId: string): Promise<RoutingPreferenceRevisionV1 | null>;
  getHead(ownerId: string, preferenceId: string): Promise<RoutingPreferenceRevisionV1 | null>;
  listByOwner(ownerId: string): Promise<RoutingPreferenceRevisionV1[]>;
  listChain(ownerId: string, preferenceId: string): Promise<RoutingPreferenceRevisionV1[]>;
}

export class RoutingPreferenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingPreferenceConflictError';
  }
}

export class RoutingPreferenceHydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingPreferenceHydrationError';
  }
}
