import { createHash } from 'node:crypto';
import {
  type HarnessHistoryPublicationAttempt,
  harnessHistoryCommitSchema,
  harnessHistoryPublicationAttemptSchema,
} from '@cat-cafe/shared';

export interface HarnessHistoryPublicationSnapshot {
  revision: number;
  baselineSourceRevision?: string;
  current?: HarnessHistoryPublicationAttempt;
  attempts: HarnessHistoryPublicationAttempt[];
}
export interface HarnessHistoryPublicationAppend {
  programId: string;
  expectedRevision: number;
  baselineSourceRevision: string;
  commandDigest: string;
  attempt: HarnessHistoryPublicationAttempt;
}
export type HarnessHistoryPublicationAppendResult =
  | { outcome: 'appended' | 'duplicate'; attempt: HarnessHistoryPublicationAttempt }
  | { outcome: 'conflict' | 'idempotency_collision' };

/** Only publication refs and receipts live here; archive bytes remain in Git. */
export interface HarnessHistoryPublicationStore {
  initializeBaseline(programId: string, sourceRevision: string): Promise<string>;
  read(programId: string): Promise<HarnessHistoryPublicationSnapshot>;
  get(programId: string, revision: number): Promise<HarnessHistoryPublicationAttempt | undefined>;
  replay(
    programId: string,
    actorRef: string,
    clientMessageId: string,
    digest: string,
  ): Promise<HarnessHistoryPublicationAppendResult | undefined>;
  append(input: HarnessHistoryPublicationAppend): Promise<HarnessHistoryPublicationAppendResult>;
}

export function historyCommandKey(actorRef: string, clientMessageId: string) {
  return createHash('sha256')
    .update(JSON.stringify([actorRef, clientMessageId]))
    .digest('hex');
}

/** Explicit test/dev injection; production composition requires the durable Redis store. */
export class MemoryHarnessHistoryPublicationStore implements HarnessHistoryPublicationStore {
  private readonly journals = new Map<
    string,
    {
      baseline: string;
      attempts: HarnessHistoryPublicationAttempt[];
      commands: Map<string, { digest: string; revision: number }>;
    }
  >();

  async initializeBaseline(programId: string, sourceRevision: string) {
    harnessHistoryCommitSchema.parse(sourceRevision);
    const existing = this.journals.get(programId);
    if (existing) return existing.baseline;
    this.journals.set(programId, { baseline: sourceRevision, attempts: [], commands: new Map() });
    return sourceRevision;
  }

  async read(programId: string): Promise<HarnessHistoryPublicationSnapshot> {
    const journal = this.journals.get(programId);
    if (!journal) return { revision: 0, attempts: [] };
    return structuredClone({
      revision: journal.attempts.length,
      baselineSourceRevision: journal.baseline,
      current: [...journal.attempts].reverse().find((attempt) => attempt.status === 'published'),
      attempts: journal.attempts.slice(-50),
    });
  }

  async get(programId: string, revision: number) {
    const attempt = this.journals.get(programId)?.attempts[revision - 1];
    return attempt ? structuredClone(attempt) : undefined;
  }

  async replay(programId: string, actorRef: string, clientMessageId: string, digest: string) {
    const journal = this.journals.get(programId);
    const command = journal?.commands.get(historyCommandKey(actorRef, clientMessageId));
    if (!command || !journal) return undefined;
    if (command.digest !== digest) return { outcome: 'idempotency_collision' as const };
    return { outcome: 'duplicate' as const, attempt: structuredClone(journal.attempts[command.revision - 1]) };
  }

  async append(input: HarnessHistoryPublicationAppend): Promise<HarnessHistoryPublicationAppendResult> {
    harnessHistoryPublicationAttemptSchema.parse(input.attempt);
    harnessHistoryCommitSchema.parse(input.baselineSourceRevision);
    // No await between the replay/CAS and append: competing callers observe one transition.
    const existing = this.journals.get(input.programId);
    const commandKey = historyCommandKey(input.attempt.actorRef, input.attempt.clientMessageId);
    const command = existing?.commands.get(commandKey);
    if (command && existing) {
      return command.digest === input.commandDigest
        ? { outcome: 'duplicate', attempt: structuredClone(existing.attempts[command.revision - 1]) }
        : { outcome: 'idempotency_collision' };
    }
    if ((existing?.attempts.length ?? 0) !== input.expectedRevision) return { outcome: 'conflict' };
    if (input.attempt.revision !== input.expectedRevision + 1) throw new Error('invalid history append sequence');
    const journal = existing ?? {
      baseline: input.baselineSourceRevision,
      attempts: [],
      commands: new Map<string, { digest: string; revision: number }>(),
    };
    journal.attempts.push(structuredClone(input.attempt));
    journal.commands.set(commandKey, { digest: input.commandDigest, revision: input.attempt.revision });
    this.journals.set(input.programId, journal);
    return { outcome: 'appended', attempt: structuredClone(input.attempt) };
  }
}
