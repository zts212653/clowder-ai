import type { MeetingIntake } from '@cat-cafe/shared';

export interface AcceptMeetingIntakeInput {
  readonly settlementKey: string;
  readonly sourceIdentityKey: string;
  readonly intake: MeetingIntake;
}

export type AcceptMeetingIntakeResult =
  | { readonly outcome: 'accepted'; readonly intake: MeetingIntake }
  | { readonly outcome: 'duplicate'; readonly intake: MeetingIntake }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'source_identity_conflict' };

export type MeetingIntakeCasResult =
  | { readonly outcome: 'written'; readonly intake: MeetingIntake }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'revision_conflict'; readonly intake: MeetingIntake };

export interface MeetingIntakeSettlement {
  readonly canonicalDigest: string;
  readonly intakeId: string;
  readonly publicationId: string;
}

export interface MeetingIntakeStore {
  accept(input: AcceptMeetingIntakeInput): Promise<AcceptMeetingIntakeResult>;
  lookupSettlement(settlementKey: string): Promise<MeetingIntakeSettlement | null>;
  get(intakeId: string): Promise<MeetingIntake | null>;
  list(): Promise<MeetingIntake[]>;
  compareAndSet(intakeId: string, expectedRevision: number, next: MeetingIntake): Promise<MeetingIntakeCasResult>;
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class MemoryMeetingIntakeStore implements MeetingIntakeStore {
  private readonly intakes = new Map<string, MeetingIntake>();
  private readonly settlements = new Map<string, MeetingIntakeSettlement>();
  private readonly sources = new Map<string, string>();
  private readonly queue = new SerialQueue();

  async accept(input: AcceptMeetingIntakeInput): Promise<AcceptMeetingIntakeResult> {
    return this.queue.run(() => {
      const existing = this.settlements.get(input.settlementKey);
      if (existing) {
        if (existing.canonicalDigest !== input.intake.ingress.canonicalDigest) {
          return { outcome: 'idempotency_conflict' };
        }
        const intake = this.intakes.get(existing.intakeId);
        if (!intake) throw new Error('signal intake settlement points to a missing intake');
        return { outcome: 'duplicate', intake: structuredClone(intake) };
      }
      if (this.sources.has(input.sourceIdentityKey)) return { outcome: 'source_identity_conflict' };
      if (this.intakes.has(input.intake.intakeId)) throw new Error('meeting intake id collision');
      this.intakes.set(input.intake.intakeId, structuredClone(input.intake));
      this.settlements.set(input.settlementKey, {
        canonicalDigest: input.intake.ingress.canonicalDigest,
        intakeId: input.intake.intakeId,
        publicationId: input.intake.ingress.publicationId,
      });
      this.sources.set(input.sourceIdentityKey, input.intake.intakeId);
      return { outcome: 'accepted', intake: structuredClone(input.intake) };
    });
  }

  async lookupSettlement(settlementKey: string): Promise<MeetingIntakeSettlement | null> {
    const settlement = this.settlements.get(settlementKey);
    if (!settlement) return null;
    const intake = this.intakes.get(settlement.intakeId);
    if (
      !intake ||
      intake.ingress.canonicalDigest !== settlement.canonicalDigest ||
      intake.ingress.publicationId !== settlement.publicationId
    ) {
      throw new Error('signal intake settlement is inconsistent with its intake');
    }
    return structuredClone(settlement);
  }

  async get(intakeId: string): Promise<MeetingIntake | null> {
    const intake = this.intakes.get(intakeId);
    return intake ? structuredClone(intake) : null;
  }

  async list(): Promise<MeetingIntake[]> {
    return [...this.intakes.values()].map((intake) => structuredClone(intake));
  }

  async compareAndSet(
    intakeId: string,
    expectedRevision: number,
    next: MeetingIntake,
  ): Promise<MeetingIntakeCasResult> {
    return this.queue.run(() => {
      const current = this.intakes.get(intakeId);
      if (!current) return { outcome: 'missing' };
      if (current.revision !== expectedRevision) {
        return { outcome: 'revision_conflict', intake: structuredClone(current) };
      }
      if (next.intakeId !== intakeId || next.revision !== expectedRevision + 1) {
        throw new Error('meeting intake CAS candidate has invalid identity or revision');
      }
      this.intakes.set(intakeId, structuredClone(next));
      return { outcome: 'written', intake: structuredClone(next) };
    });
  }
}
