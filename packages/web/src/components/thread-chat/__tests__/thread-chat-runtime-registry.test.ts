import { describe, expect, it } from 'vitest';
import { createThreadChatRuntimeRegistry } from '../thread-chat-runtime-registry';

describe('thread chat runtime registry', () => {
  it('normalizes duplicate and empty thread ids into a deterministic union', () => {
    const registry = createThreadChatRuntimeRegistry();

    expect(registry.replaceConsumerRegistration('primary', [' thread-b ', '', 'thread-a', 'thread-b'])).toBe(true);
    expect(registry.snapshot()).toEqual(['thread-a', 'thread-b']);
    expect(registry.replaceConsumerRegistration('primary', ['thread-b', 'thread-a'])).toBe(false);
  });

  it('keeps a shared thread until the last consumer unregisters', () => {
    const registry = createThreadChatRuntimeRegistry();

    expect(registry.replaceConsumerRegistration('primary', ['thread-a'])).toBe(true);
    expect(registry.replaceConsumerRegistration('split', ['thread-a', 'thread-b'])).toBe(true);
    expect(registry.snapshot()).toEqual(['thread-a', 'thread-b']);

    expect(registry.removeConsumerRegistration('primary')).toBe(false);
    expect(registry.snapshot()).toEqual(['thread-a', 'thread-b']);
    expect(registry.removeConsumerRegistration('split')).toBe(true);
    expect(registry.snapshot()).toEqual([]);
  });

  it('replaces one consumer registration atomically', () => {
    const registry = createThreadChatRuntimeRegistry();
    registry.replaceConsumerRegistration('primary', ['thread-a']);
    registry.replaceConsumerRegistration('secondary', ['thread-b']);

    expect(registry.replaceConsumerRegistration('primary', ['thread-b', 'thread-c'])).toBe(true);
    expect(registry.snapshot()).toEqual(['thread-b', 'thread-c']);
  });

  it('makes stale or repeated cleanup idempotent', () => {
    const registry = createThreadChatRuntimeRegistry();
    registry.replaceConsumerRegistration('primary', ['thread-a']);

    expect(registry.removeConsumerRegistration('primary')).toBe(true);
    expect(registry.removeConsumerRegistration('primary')).toBe(false);
    expect(registry.removeConsumerRegistration('unknown')).toBe(false);
    expect(registry.snapshot()).toEqual([]);
  });
});
