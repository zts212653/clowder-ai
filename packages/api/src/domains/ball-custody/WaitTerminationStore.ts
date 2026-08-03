import {
  type HumanDispositionLedgerEntry,
  type HumanDispositionLedgerReceipt,
  humanDispositionLedgerEntrySchema,
  type UserCancelWaitTerminationEventV1,
  userCancelWaitTerminationEventSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const waitTerminationRecordSchema = z
  .object({
    event: userCancelWaitTerminationEventSchema,
    entry: humanDispositionLedgerEntrySchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.entry.episode.sourceRef !== record.event.eventId ||
      record.entry.episode.subjectRef !== record.event.subjectRef ||
      record.entry.episode.ownerUserId !== record.event.ownerUserId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'disposition entry must be bound to the canonical termination event',
        path: ['entry'],
      });
    }
  });

export interface WaitTerminationRecord {
  event: UserCancelWaitTerminationEventV1;
  entry: HumanDispositionLedgerEntry;
}

export type WaitTerminationCommitOutcome = 'applied' | 'replay' | 'conflict';

export interface WaitTerminationStore {
  getByWaitId(waitId: string): Promise<WaitTerminationRecord | null>;
  commit(record: WaitTerminationRecord): Promise<WaitTerminationCommitOutcome>;
  loadEntry(input: {
    ownerUserId: string;
    receipt: HumanDispositionLedgerReceipt;
  }): Promise<HumanDispositionLedgerEntry | null>;
  listRecords(): Promise<WaitTerminationRecord[]>;
}
