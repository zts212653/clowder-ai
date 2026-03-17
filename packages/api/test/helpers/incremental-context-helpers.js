export function mockMsg(overrides) {
  const ts = overrides.timestamp ?? Date.now();
  return {
    threadId: overrides.threadId ?? 'thread-1',
    userId: overrides.userId ?? 'user-1',
    catId: overrides.catId ?? null,
    content: overrides.content ?? 'test message',
    mentions: overrides.mentions ?? [],
    timestamp: ts,
    origin: overrides.origin ?? undefined,
    extra: overrides.extra ?? undefined,
  };
}

export function seedMessages(messageStore, count, threadId = 'thread-1') {
  const stored = [];
  const baseTs = Date.now() - count * 1000;
  for (let i = 0; i < count; i++) {
    const msg = mockMsg({ threadId, content: `message-${i}`, timestamp: baseTs + i * 1000 });
    stored.push(messageStore.append(msg));
  }
  return stored;
}

export function buildDeps(messageStore, deliveryCursorStore) {
  return { services: {}, invocationDeps: {}, messageStore, deliveryCursorStore };
}
