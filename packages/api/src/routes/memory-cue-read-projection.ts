import type { CatId, MatterReadSummary } from '@cat-cafe/shared';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { MemoryCueEpisodeStore } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import {
  type MemoryCueInvocationCueEntry,
  projectInvocationCues,
} from '../domains/memory/cue/project-invocation-cues.js';
import type { MemoryCueInvocationReadOptions } from './memory-cue-invocation-read.js';
import { memoryInvocationAccess } from './memory-invocation-access.js';

interface ReadFailure {
  status: 403 | 404 | 409 | 503;
  error: string;
}
interface OwnerCue extends Omit<MemoryCueInvocationCueEntry, 'readDetails'> {
  matterRead?: MatterReadSummary;
}
export type OwnerCueRead = ReadFailure | { status: 200; cues: OwnerCue[] };

export async function cueThreadAccess(
  opts: MemoryCueInvocationReadOptions,
  userId: string,
  threadId: string,
): Promise<ReadFailure | null> {
  if (!opts.threadStore) return { status: 503, error: 'Thread store unavailable' };
  const thread = await opts.threadStore.get(threadId);
  if (!thread || thread.deletedAt) return { status: 404, error: 'Thread not found' };
  const indexed =
    thread.createdBy === 'system' && (await opts.threadStore.list(userId)).some((item) => item.id === threadId);
  return canAccessThread(thread, userId) || indexed ? null : { status: 403, error: 'Forbidden' };
}

async function invocationCats(opts: MemoryCueInvocationReadOptions, invocationId: string) {
  const parent = await opts.invocationRecordStore?.get(invocationId);
  const child = parent ? null : await opts.turnExecutionStore?.get(invocationId);
  return parent?.targetCats ?? (child ? [child.catId] : []);
}

/** The same owner projection backs the legacy single read and the bounded batch. */
export async function readOwnerCueInvocation(
  opts: MemoryCueInvocationReadOptions,
  episodes: MemoryCueEpisodeStore,
  userId: string,
  threadId: string,
  invocationId: string,
  includeMatter: boolean,
): Promise<OwnerCueRead> {
  const access = await memoryInvocationAccess(opts, userId, threadId, invocationId);
  if (access.status !== 200) return access;
  const cats = await invocationCats(opts, invocationId);
  const cues: OwnerCue[] = [];
  for (const cue of projectInvocationCues(episodes.listByInvocation(userId, threadId, invocationId))) {
    if (cue.resolverFamily !== 'matter') {
      cues.push(cue);
      continue;
    }
    if (!includeMatter || !cats.includes(cue.consumerCatId as CatId) || !cue.readDetails) continue;
    const read = await opts.matterMemoryService?.readReceipt(userId, cue.consumerCatId as CatId, cue.readDetails, true);
    const matterRead: MatterReadSummary =
      read?.status === 'current'
        ? {
            status: 'current',
            matterId: read.page.matter.matterId,
            title: read.page.matter.title,
            messageCount: new Set(
              read.page.entries.map((entry) => `${entry.source.threadId}:${entry.source.messageId}`),
            ).size,
          }
        : read?.status === 'changed'
          ? { status: 'changed', matterId: cue.readDetails.matterId }
          : { status: 'not_available' };
    const { readDetails: _details, ...projection } = cue;
    cues.push({ ...projection, ...(matterRead.status === 'not_available' ? { sourceAnchor: '' } : {}), matterRead });
  }
  return finalizeOwnerCueRead(opts, userId, threadId, invocationId, { status: 200, cues });
}

/** A later batch item may revoke an earlier item's authority before publication. */
export async function finalizeOwnerCueRead(
  opts: MemoryCueInvocationReadOptions,
  userId: string,
  threadId: string,
  invocationId: string,
  result: OwnerCueRead,
): Promise<OwnerCueRead> {
  const access = await memoryInvocationAccess(opts, userId, threadId, invocationId);
  if (access.status !== 200) return access;
  if (result.status !== 200 || !result.cues.some((cue) => cue.resolverFamily === 'matter')) return result;
  const cats = await invocationCats(opts, invocationId);
  return {
    status: 200,
    cues: result.cues.filter((cue) => cue.resolverFamily !== 'matter' || cats.includes(cue.consumerCatId as CatId)),
  };
}
