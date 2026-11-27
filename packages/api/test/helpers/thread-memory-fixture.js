export function createThreadMemoryFixture() {
  const threads = new Map();
  return {
    async set(input) {
      const entries = threads.get(input.threadId) ?? new Map();
      const entry = { ...input, updatedAt: Date.now() };
      entries.set(input.key, entry);
      threads.set(input.threadId, entries);
      return entry;
    },
    async get(threadId, key) {
      return threads.get(threadId)?.get(key) ?? null;
    },
    async list(threadId) {
      return Array.from(threads.get(threadId)?.values() ?? []);
    },
    async delete(threadId, key) {
      return threads.get(threadId)?.delete(key) ?? false;
    },
  };
}
