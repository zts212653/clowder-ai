import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { DestinationAuthority, HostDestinationRecord } from './DestinationAuthority.js';

export interface MeetingThreadStore {
  get(threadId: string): Thread | null | Promise<Thread | null>;
}

const PREFIX = 'host:private-thread:';

export function parsePrivateThreadHandle(handle: string): string | null {
  if (!handle.startsWith(PREFIX)) return null;
  const threadId = handle.slice(PREFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(threadId)) return null;
  if (handle !== `${PREFIX}${threadId}`) return null;
  return threadId;
}

export class ThreadDestinationAuthority implements DestinationAuthority {
  constructor(private readonly threads: MeetingThreadStore) {}

  async resolve(handle: string, ownerId: string): Promise<HostDestinationRecord | null> {
    const threadId = parsePrivateThreadHandle(handle);
    if (!threadId) return null;
    const thread = await this.threads.get(threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== ownerId) return null;
    return { handle, kind: 'private-thread', targetId: threadId, ownerId };
  }
}
