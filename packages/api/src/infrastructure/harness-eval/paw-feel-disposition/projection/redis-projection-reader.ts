import { setImmediate } from 'node:timers/promises';
import type { PawFeelDispositionEvent, PawFeelDispositionProjection } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { projectPawFeelDisposition } from '../projector.js';
import { awaitPawFeelRead, mapPawFeelReads } from './bounded-reads.js';

/** Disposable snapshots validated against the append-only canonical log on every
 * read. No time-based staleness and no second lifecycle owner. */
export class RedisPawFeelProjectionReader {
  private readonly projections = new Map<string, PawFeelDispositionProjection>();
  constructor(
    private readonly redis: RedisClient,
    private readonly key: (id: string) => string,
    private readonly read: (id: string, from: number, to: number) => Promise<PawFeelDispositionEvent[]>,
  ) {}

  async readMany(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, PawFeelDispositionProjection>> {
    const output = new Map<string, PawFeelDispositionProjection>();
    for (let offset = 0; offset < ids.length; offset += 64) {
      signal?.throwIfAborted();
      const batch = ids.slice(offset, offset + 64);
      const pipeline = this.redis.pipeline();
      for (const id of batch) pipeline.llen(this.key(id));
      const replies = await awaitPawFeelRead(pipeline.exec(), signal);
      await mapPawFeelReads(
        batch.map((id, index) => ({ id, index })),
        async ({ id, index }) => {
          const reply = replies?.[index];
          if (!reply || reply[0]) throw reply?.[0] ?? new Error('Incomplete paw-feel projection revision read');
          const length = reply[1];
          if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
            throw new Error('Invalid paw-feel projection revision');
          if (length === 0) {
            this.projections.delete(id);
            return;
          }
          let cached = this.projections.get(id);
          if (cached && cached.sequence > length) cached = undefined;
          while ((cached?.sequence ?? 0) < length) {
            signal?.throwIfAborted();
            const from = cached?.sequence ?? 0;
            const events = await awaitPawFeelRead(this.read(id, from, Math.min(length - 1, from + 249)), signal);
            if (events.length === 0) throw new Error(`signal ${id} log changed during projection`);
            cached = projectPawFeelDisposition(events, cached);
            await setImmediate();
          }
          if (!cached) throw new Error(`signal ${id} has no durable events`);
          this.projections.delete(id);
          this.projections.set(id, cached);
          if (this.projections.size > 20_000) this.projections.delete(this.projections.keys().next().value!);
          output.set(id, structuredClone(cached));
        },
        signal,
      );
    }
    return output;
  }
}
