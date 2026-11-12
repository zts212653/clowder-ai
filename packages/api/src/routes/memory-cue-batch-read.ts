import type { MemoryCueEpisodeStore } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import type { MemoryCueInvocationReadOptions } from './memory-cue-invocation-read.js';
import { finalizeOwnerCueRead, type OwnerCueRead, readOwnerCueInvocation } from './memory-cue-read-projection.js';

/** Match the existing 100-invocation history window and bound JSON parsing work. */
export function parseCueInvocationBatch(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length > 16_384) return null;
  try {
    const ids: unknown = JSON.parse(raw);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string' || !id.length || id.length > 500)
    )
      return null;
    return [...new Set(ids as string[])];
  } catch {
    return null;
  }
}

/** Preserve the old four-read concurrency bound while reducing HTTP fanout. */
export async function readOwnerCueBatch(
  opts: MemoryCueInvocationReadOptions,
  episodes: MemoryCueEpisodeStore,
  userId: string,
  threadId: string,
  ids: string[],
  includeMatter: boolean,
  signal: AbortSignal,
) {
  const projected: Array<{ invocationId: string } & OwnerCueRead> = [];
  for (let offset = 0; offset < ids.length; offset += 4) {
    signal.throwIfAborted();
    projected.push(
      ...(await Promise.all(
        ids.slice(offset, offset + 4).map(async (invocationId) => {
          try {
            const result = await readOwnerCueInvocation(opts, episodes, userId, threadId, invocationId, includeMatter);
            return { invocationId, ...result };
          } catch {
            return { invocationId, status: 503 as const, error: 'Cue source unavailable' };
          }
        }),
      )),
    );
  }
  const refreshed: typeof projected = [];
  for (let offset = 0; offset < projected.length; offset += 4) {
    signal.throwIfAborted();
    refreshed.push(
      ...(await Promise.all(
        projected.slice(offset, offset + 4).map(async (row) => {
          if (row.status !== 200 || !row.cues.some((cue) => cue.resolverFamily === 'matter')) return row;
          try {
            const result = await readOwnerCueInvocation(
              opts,
              episodes,
              userId,
              threadId,
              row.invocationId,
              includeMatter,
            );
            return { invocationId: row.invocationId, ...result };
          } catch {
            return { invocationId: row.invocationId, status: 503 as const, error: 'Cue source unavailable' };
          }
        }),
      )),
    );
  }
  // All source revalidation must finish before any publication authority check.
  const current: typeof projected = [];
  for (let offset = 0; offset < refreshed.length; offset += 4) {
    signal.throwIfAborted();
    current.push(
      ...(await Promise.all(
        refreshed.slice(offset, offset + 4).map(async (row) => {
          try {
            const result = await finalizeOwnerCueRead(opts, userId, threadId, row.invocationId, row);
            return { invocationId: row.invocationId, ...result };
          } catch {
            return { invocationId: row.invocationId, status: 503 as const, error: 'Cue source unavailable' };
          }
        }),
      )),
    );
  }
  signal.throwIfAborted();
  return current;
}
