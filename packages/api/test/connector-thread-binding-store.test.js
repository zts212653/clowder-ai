import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

describe('MemoryConnectorThreadBindingStore', () => {
  let store;
  beforeEach(() => {
    store = new MemoryConnectorThreadBindingStore();
  });

  it('bind() creates and returns a binding', () => {
    const b = store.bind('feishu', 'chat-123', 'thread-abc', 'user-1');
    assert.equal(b.connectorId, 'feishu');
    assert.equal(b.externalChatId, 'chat-123');
    assert.equal(b.threadId, 'thread-abc');
    assert.equal(b.userId, 'user-1');
    assert.ok(b.createdAt > 0);
  });

  it('getByExternal() returns bound thread', () => {
    store.bind('feishu', 'chat-123', 'thread-abc', 'user-1');
    const b = store.getByExternal('feishu', 'chat-123');
    assert.equal(b?.threadId, 'thread-abc');
  });

  it('getByExternal() returns null for unknown', () => {
    assert.equal(store.getByExternal('feishu', 'nope'), null);
  });

  it('getByThread() returns all bindings for a thread', () => {
    store.bind('feishu', 'chat-1', 'thread-abc', 'user-1');
    store.bind('telegram', 'chat-2', 'thread-abc', 'user-1');
    const bindings = store.getByThread('thread-abc');
    assert.equal(bindings.length, 2);
  });

  it('bind() overwrites existing binding for same connector+externalChatId', () => {
    store.bind('feishu', 'chat-123', 'thread-old', 'user-1');
    store.bind('feishu', 'chat-123', 'thread-new', 'user-1');
    assert.equal(store.getByExternal('feishu', 'chat-123')?.threadId, 'thread-new');
  });

  it('remove() deletes a binding', () => {
    store.bind('feishu', 'chat-123', 'thread-abc', 'user-1');
    assert.equal(store.remove('feishu', 'chat-123'), true);
    assert.equal(store.getByExternal('feishu', 'chat-123'), null);
  });

  it('remove() returns false for unknown', () => {
    assert.equal(store.remove('feishu', 'nope'), false);
  });

  it('setHubThread() attaches hubThreadId to existing binding', () => {
    store.bind('feishu', 'chat-123', 'thread-abc', 'user-1');
    const updated = store.setHubThread('feishu', 'chat-123', 'hub-thread-1');
    assert.ok(updated);
    assert.equal(updated.hubThreadId, 'hub-thread-1');
    assert.equal(updated.threadId, 'thread-abc');
    assert.equal(store.getByExternal('feishu', 'chat-123').hubThreadId, 'hub-thread-1');
  });

  it('setHubThread() returns null for non-existent binding', () => {
    assert.equal(store.setHubThread('feishu', 'nope', 'hub-1'), null);
  });

  it('setHubThread() preserves other binding fields', () => {
    store.bind('feishu', 'chat-123', 'thread-abc', 'user-1');
    const updated = store.setHubThread('feishu', 'chat-123', 'hub-1');
    assert.equal(updated.connectorId, 'feishu');
    assert.equal(updated.externalChatId, 'chat-123');
    assert.equal(updated.userId, 'user-1');
    assert.ok(updated.createdAt > 0);
  });
});
