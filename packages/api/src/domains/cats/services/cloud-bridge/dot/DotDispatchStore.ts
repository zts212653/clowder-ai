import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const ref = z.string().min(1).max(512);
export const dotDispatchRecordSchema = z
  .object({
    eventId: z.string().regex(/^dot_evt_[a-f0-9]{64}$/),
    ownerUserId: ref,
    threadId: ref,
    sourceMessageId: ref,
    dispatchInvocationId: ref,
    attemptId: ref,
    agentKeyId: ref,
    occurredAt: z.number(),
    webhookAcknowledgedAt: z.number().nullable(),
    sourceReadAt: z.number().nullable(),
    replyMessageId: ref.nullable(),
    imagePublicationIds: z.array(ref),
    imageReservationIds: z.array(ref).optional(),
    connectionTest: z.boolean().default(false),
    expectedNonce: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  })
  .strict();
export type DotDispatchRecord = z.infer<typeof dotDispatchRecordSchema>;

export function dotEventId(attemptId: string, threadId: string, sourceMessageId: string, invocationId: string): string {
  return `dot_evt_${createHash('sha256')
    .update(JSON.stringify([attemptId, threadId, sourceMessageId, invocationId]))
    .digest('hex')}`;
}

/** Outbound and consumption evidence references the original source; it never owns Task state. */
export class DotDispatchStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}

  async read(id: string): Promise<DotDispatchRecord | null> {
    await this.pending.get(id);
    return this.readFile(id);
  }

  update<T>(
    id: string,
    change: (record: DotDispatchRecord | null) => Promise<{ record: DotDispatchRecord; result: T }>,
  ): Promise<T> {
    const path = this.path(id);
    const work = (this.pending.get(id) ?? Promise.resolve()).then(async () => {
      const { record, result } = await change(await this.readFile(id));
      const validated = dotDispatchRecordSchema.parse(record);
      if (validated.eventId !== id) throw new Error('dot_event_identity_mismatch');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(validated)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return result;
    });
    const settled = work.catch(() => undefined);
    this.pending.set(id, settled);
    void settled.finally(() => {
      if (this.pending.get(id) === settled) this.pending.delete(id);
    });
    return work;
  }

  private path(id: string) {
    if (!/^dot_evt_[a-f0-9]{64}$/.test(id)) throw new Error('dot_event_id_invalid');
    return join(this.directory, `${id}.json`);
  }

  private async readFile(id: string) {
    try {
      return dotDispatchRecordSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
