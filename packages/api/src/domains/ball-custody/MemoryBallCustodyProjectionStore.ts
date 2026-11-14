import type { BallCustodyProjection } from '@cat-cafe/shared';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import { BallProbeRecoveryOwner } from './BallProbeRecoveryOwner.js';
import {
  BallProbeRecoveryConflict,
  type BallRecoveryBackend,
  BallRecoveryIndex,
  BallRecoveryMutation,
} from './ball-probe-recovery-backend.js';
import { type BallProbeRecoveryFacts, ballProbeScores, reconcileBallProbeFacts } from './ball-probe-recovery-state.js';

class DueIndex {
  private readonly members = new Set<string>();
  private readonly ordered: Array<{ subject: string; at: number }> = [];
  set(subject: string, at: number | null): void {
    if (this.members.delete(subject))
      this.ordered.splice(
        this.ordered.findIndex((row) => row.subject === subject),
        1,
      );
    if (at === null) return;
    let low = 0,
      high = this.ordered.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.ordered[mid]!.at <= at) low = mid + 1;
      else high = mid;
    }
    this.ordered.splice(low, 0, { subject, at });
    this.members.add(subject);
  }
  due(before: number, limit: number): string[] {
    const result: string[] = [];
    for (const row of this.ordered) {
      if (row.at > before || result.length >= limit) break;
      result.push(row.subject);
    }
    return result;
  }
}
class MemoryBallRecoveryBackend implements BallRecoveryBackend {
  readonly projections = new Map<string, BallCustodyProjection>();
  private readonly archive = new Map<string, Map<string, string>>();
  private readonly metadata = new Map<string, BallProbeRecoveryFacts>();
  private indexes: Record<BallRecoveryIndex, DueIndex> = {
    probe: new DueIndex(),
    idle: new DueIndex(),
    retry: new DueIndex(),
    notice: new DueIndex(),
    audit: new DueIndex(),
  };
  async readArchive(subject: string, key: string) {
    return this.archive.get(subject)?.get(key) ?? null;
  }
  async readFacts(subject: string) {
    return structuredClone(this.metadata.get(subject) ?? null);
  }
  async mutate<T>(
    subject: string,
    change: (input: {
      projection: BallCustodyProjection | null;
      facts: BallProbeRecoveryFacts;
    }) => BallRecoveryMutation<T>,
  ): Promise<T> {
    const projection = structuredClone(this.projections.get(subject) ?? null);
    const facts: BallProbeRecoveryFacts = structuredClone(
      this.metadata.get(subject) ?? { v: 1, subjectKey: subject, generation: 0, notices: {} },
    );
    const output = change({ projection, facts }),
      nextFacts = output.facts ?? facts;
    const next = output.projection === undefined ? projection : output.projection;
    if (output.requireArchiveAbsent && this.archive.get(subject)?.has(output.requireArchiveAbsent))
      throw new BallProbeRecoveryConflict('ball_recovery_archive_already_recorded');
    if (output.mode === 'write' && next) this.projections.set(subject, structuredClone(next));
    if (output.mode === 'delete') this.projections.delete(subject);
    this.metadata.set(subject, nextFacts);
    if (output.archive) {
      let entries = this.archive.get(subject);
      if (!entries) {
        entries = new Map();
        this.archive.set(subject, entries);
      }
      for (const [key, value] of Object.entries(output.archive)) entries.set(key, value);
    }
    const scores = ballProbeScores(next, nextFacts);
    for (const lane of ['probe', 'idle', 'retry', 'notice', 'audit'] as const)
      this.indexes[lane].set(subject, scores[lane]);
    return output.result;
  }
  async initialize(rebuild = false): Promise<void> {
    if (!rebuild) return;
    this.indexes = {
      probe: new DueIndex(),
      idle: new DueIndex(),
      retry: new DueIndex(),
      notice: new DueIndex(),
      audit: new DueIndex(),
    };
    for (const subject of new Set([...this.projections.keys(), ...this.metadata.keys()]))
      await this.mutate(subject, ({ projection, facts }) => ({
        result: undefined,
        facts: reconcileBallProbeFacts(subject, projection, facts),
      }));
  }
  async due(index: BallRecoveryIndex, before: number, limit: number) {
    return this.indexes[index].due(before, limit);
  }
}

/** Same original-owner recovery policy as Redis, including protection across public projection delete/replay. */
export class MemoryBallCustodyProjectionStore extends BallProbeRecoveryOwner implements IBallCustodyProjectionStore {
  readonly projections: Map<string, BallCustodyProjection>;
  constructor(memory = new MemoryBallRecoveryBackend()) {
    super(memory);
    this.projections = memory.projections;
  }
  async get(subject: string) {
    return structuredClone(this.projections.get(subject) ?? null);
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
}
