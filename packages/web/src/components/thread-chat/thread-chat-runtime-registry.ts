export interface ThreadChatRuntimeRegistry {
  replaceConsumerRegistration(consumerId: string, threadIds: readonly string[]): boolean;
  removeConsumerRegistration(consumerId: string): boolean;
  snapshot(): string[];
}

export function normalizeThreadIds(threadIds: readonly string[]): string[] {
  return [...new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean))].sort();
}

function snapshotRegistrations(registrations: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const union = new Set<string>();
  for (const threadIds of registrations.values()) {
    for (const threadId of threadIds) union.add(threadId);
  }
  return [...union].sort();
}

function snapshotKey(registrations: ReadonlyMap<string, ReadonlySet<string>>): string {
  return snapshotRegistrations(registrations).join('\u0000');
}

export function createThreadChatRuntimeRegistry(): ThreadChatRuntimeRegistry {
  const registrations = new Map<string, ReadonlySet<string>>();

  return {
    replaceConsumerRegistration(consumerId, threadIds) {
      if (!consumerId) throw new Error('Thread chat runtime consumer id is required');

      const before = snapshotKey(registrations);
      const normalized = normalizeThreadIds(threadIds);
      if (normalized.length === 0) registrations.delete(consumerId);
      else registrations.set(consumerId, new Set(normalized));
      return before !== snapshotKey(registrations);
    },

    removeConsumerRegistration(consumerId) {
      const before = snapshotKey(registrations);
      registrations.delete(consumerId);
      return before !== snapshotKey(registrations);
    },

    snapshot() {
      return snapshotRegistrations(registrations);
    },
  };
}
