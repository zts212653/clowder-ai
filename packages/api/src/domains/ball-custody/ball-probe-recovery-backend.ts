import type { BallCustodyProjection } from '@cat-cafe/shared';
import type { BallProbeRecoveryFacts } from './ball-probe-recovery-state.js';

export type BallRecoveryIndex = 'probe' | 'idle' | 'retry' | 'notice' | 'audit';
export interface BallRecoveryMutation<T> {
  result: T;
  archive?: Record<string, string>;
  requireArchiveAbsent?: string;
  facts?: BallProbeRecoveryFacts;
  mode?: 'keep' | 'write' | 'delete';
  projection?: BallCustodyProjection | null;
}
export interface BallRecoveryBackend {
  readArchive(subject: string, key: string): Promise<string | null>;
  readFacts(subject: string): Promise<BallProbeRecoveryFacts | null>;
  mutate<T>(
    subject: string,
    change: (input: {
      projection: BallCustodyProjection | null;
      facts: BallProbeRecoveryFacts;
    }) => BallRecoveryMutation<T>,
  ): Promise<T>;
  initialize(rebuild?: boolean): Promise<void>;
  due(index: BallRecoveryIndex, before: number, limit: number): Promise<string[]>;
}

export class BallProbeRecoveryConflict extends Error {}
export class BallProbeRecoveryCensusPending extends Error {}
