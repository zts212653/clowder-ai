import type { MatterReadSummary, RecallResolverFamily } from '@cat-cafe/shared';
import { readScopedRecallJson } from './recall-scoped-read';
import type { MemoryCueStatus, RecallEvent } from './recall-types';

export interface CueRead {
  id: string;
  token: string;
}
interface CueEntry {
  pushSurface?: string;
  source?: 'push' | 'pull';
  matterRead?: MatterReadSummary;
  cueId: string;
  consumerCatId: string;
  sourceAnchor: string;
  sourceRevision: string;
  resolverFamily: RecallResolverFamily;
  status: MemoryCueStatus;
  presentedAt: number;
}
export interface CueReadResult {
  token: string;
  events: RecallEvent[];
  failed: boolean;
}

export function cueReadBatches(reads: CueRead[]): CueRead[][] {
  const batches: CueRead[][] = [];
  let batch: CueRead[] = [];
  for (const read of reads) {
    const next = [...batch, read];
    if (
      batch.length &&
      (next.length > 100 || encodeURIComponent(JSON.stringify(next.map((item) => item.id))).length > 6000)
    ) {
      batches.push(batch);
      batch = [];
    }
    batch.push(read);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function readCueBatch(
  threadId: string,
  reads: CueRead[],
  generation: number,
  signal: AbortSignal,
): Promise<Map<string, CueReadResult>> {
  const encoded = encodeURIComponent(JSON.stringify(reads.map((read) => read.id)));
  const body = (await readScopedRecallJson(
    `/api/threads/${encodeURIComponent(threadId)}/memory-cues?invocationIds=${encoded}`,
    JSON.stringify([generation, reads]),
    signal,
  )) as {
    invocations?: Array<{ invocationId: string; status: number; cues?: CueEntry[] }>;
  };
  if (!Array.isArray(body?.invocations)) throw new Error('Cue batch unavailable');
  const rows = new Map(body.invocations.map((row) => [row.invocationId, row]));
  if (
    rows.size !== reads.length ||
    body.invocations.length !== reads.length ||
    reads.some((read) => !rows.has(read.id))
  )
    throw new Error('Cue batch scope mismatch');
  return new Map<string, CueReadResult>(
    reads.map(({ id: invocationId, token }): [string, CueReadResult] => {
      const row = rows.get(invocationId);
      if (!row || row.status !== 200 || !Array.isArray(row.cues))
        return [invocationId, { token, events: [], failed: true }];
      const events: RecallEvent[] = row.cues.map((cue) => ({
        id: `cue:${invocationId}:${cue.cueId}`,
        catId: cue.consumerCatId === 'legacy-unbound' ? undefined : cue.consumerCatId,
        invocationId,
        cueId: cue.cueId,
        sourceRevision: cue.sourceRevision,
        query: '',
        resolverFamily: cue.resolverFamily,
        timestamp: cue.presentedAt,
        source: cue.source ?? 'push',
        pushSurface: cue.pushSurface,
        ...(cue.matterRead ? { matterRead: cue.matterRead } : {}),
        cueStatus: cue.status,
        results: [{ title: '', anchor: cue.sourceAnchor, sourceType: cue.resolverFamily }],
      }));
      return [invocationId, { token, events, failed: false }];
    }),
  );
}
