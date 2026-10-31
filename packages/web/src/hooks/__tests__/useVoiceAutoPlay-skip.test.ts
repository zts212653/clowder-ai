/**
 * Regression test for the currentBlockId + skip race window fix (PR #809 R2 P2).
 *
 * Bug: When skip fires before markPlayed is called in the normal playback path,
 * the skip callback would cleanup + re-scan, finding the SAME block again because
 * it wasn't yet marked as played. This caused an infinite skip-replay loop.
 *
 * Fix: The skip callback now calls markPlayed(currentBlockId) before cleanup
 * and re-scan, closing the race window.
 *
 * IMPORTANT: This test drives the REAL skip callback via __testing__ exports,
 * not a mock. Deleting the markPlayed(currentBlockId) line in useVoiceAutoPlay.ts
 * WILL cause the "marks current block as played" test to fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';

// Mock chatStore — skip's re-scan calls useChatStore.getState().messages
vi.mock('../../stores/chatStore', () => ({
  useChatStore: Object.assign(() => ({ messages: [], currentThreadId: 'thread-1' }), {
    getState: () => ({ messages: [], currentThreadId: 'thread-1' }),
    subscribe: () => () => {},
    setState: () => {},
    destroy: () => {},
  }),
}));

// Mock tts-stream (imported by useVoiceAutoPlay at module level)
vi.mock('../../utils/tts-stream', () => ({
  base64ToBlob: vi.fn(),
  streamTts: vi.fn(),
}));

// Mock api-client (imported by useVoiceAutoPlay at module level)
vi.mock('../../utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
}));

// Import AFTER mocks are set up
const { __testing__ } = await import('../useVoiceAutoPlay');

beforeEach(() => {
  useVoiceSessionStore.setState({ session: null });
  __testing__.setCurrentBlockId(null);
  __testing__.cleanupAutoplay();
});

afterEach(() => {
  __testing__.cleanupAutoplay();
});

describe('skip race window regression (PR #809)', () => {
  it('real skip callback marks current block as played before re-scan', () => {
    // Setup: active voice session, block "block-A" playing but NOT yet markPlayed
    const store = useVoiceSessionStore.getState();
    store.start('thread-1', 'opus', true);
    store.setPlaybackState('playing');

    // Simulate the race window: currentBlockId is set, but markPlayed not called yet
    __testing__.setCurrentBlockId('block-A');
    expect(store.hasPlayed('block-A')).toBe(false);

    // Register the REAL autoplay skip callback (the production code path)
    __testing__.registerAutoplayStop();

    // Fire skipAudio — this invokes the REAL skip callback in useVoiceAutoPlay.ts
    useVoiceSessionStore.getState().skipAudio();

    // The real skip callback must have called markPlayed('block-A') before re-scan.
    // If someone deletes the `markPlayed(currentBlockId)` line, this assertion fails.
    expect(useVoiceSessionStore.getState().hasPlayed('block-A')).toBe(true);
  });

  it('skip without currentBlockId does not crash and goes idle', () => {
    const store = useVoiceSessionStore.getState();
    store.start('thread-1', 'opus', true);
    store.setPlaybackState('playing');

    // currentBlockId is null (no block loaded yet)
    __testing__.setCurrentBlockId(null);

    __testing__.registerAutoplayStop();
    useVoiceSessionStore.getState().skipAudio();

    // Should gracefully go idle (no unplayed blocks in empty message list)
    expect(useVoiceSessionStore.getState().session?.playbackState).toBe('idle');
  });

  it('skip advances to idle when no more unplayed blocks', () => {
    const store = useVoiceSessionStore.getState();
    store.start('thread-1', 'opus', true);
    store.setPlaybackState('playing');

    __testing__.setCurrentBlockId('block-X');
    __testing__.registerAutoplayStop();
    useVoiceSessionStore.getState().skipAudio();

    // block-X marked + no more blocks in empty messages → idle
    expect(useVoiceSessionStore.getState().hasPlayed('block-X')).toBe(true);
    expect(useVoiceSessionStore.getState().session?.playbackState).toBe('idle');
  });

  it('cleanup resets currentBlockId', () => {
    __testing__.setCurrentBlockId('block-Z');
    expect(__testing__.getCurrentBlockId()).toBe('block-Z');

    __testing__.cleanupAutoplay();
    expect(__testing__.getCurrentBlockId()).toBeNull();
  });

  it('unregistered playback control is not called on skip', () => {
    const skipFn = vi.fn();
    const store = useVoiceSessionStore.getState();
    const unregister = store.registerPlaybackControl('ephemeral', {
      pause: vi.fn(),
      resume: vi.fn(),
      skip: skipFn,
    });

    unregister();
    store.skipAudio();

    expect(skipFn).not.toHaveBeenCalled();
  });
});
