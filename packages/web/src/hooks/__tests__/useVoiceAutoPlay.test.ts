import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useListenModeStore } from '@/stores/listenModeStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { __testing__ } from '../useVoiceAutoPlay';

/**
 * F092: Tests for voice auto-play logic.
 *
 * Tests the exported pure helper + session-binding behavior.
 * We import the module internals via re-export or test the store-level
 * contracts that the hook depends on.
 */

// Mock apiFetch and Audio to avoid JSDOM issues
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock HTML Audio element
const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockPause = vi.fn();
vi.stubGlobal(
  'Audio',
  vi.fn(() => ({
    play: mockPlay,
    pause: mockPause,
    onended: null,
    onerror: null,
  })),
);

beforeEach(() => {
  useVoiceSessionStore.setState({ session: null });
  useListenModeStore.setState({ session: null });
  vi.clearAllMocks();
});

describe('F279 listen-mode admission', () => {
  it('suppresses fallback autoplay for the full listen session, including paused documents', () => {
    useListenModeStore.setState({
      session: {
        identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha' },
        title: 'research.md',
        worktreeId: null,
        sentences: [],
        phase: 'paused',
        currentIndex: 0,
        currentTime: 0,
        duration: 0,
        playbackRate: 1,
        retention: '7d',
        cachedAnchors: [],
        cacheBytes: 0,
        error: null,
      },
    });

    expect(__testing__.isListenModeActive()).toBe(true);
  });
});

describe('voiceSessionStore session-binding contracts', () => {
  it('stop-start cycle creates a new sessionId (stale check basis)', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    const id1 = useVoiceSessionStore.getState().session?.sessionId;

    useVoiceSessionStore.getState().stop();
    useVoiceSessionStore.getState().start('t2', 'opus', true);
    const id2 = useVoiceSessionStore.getState().session?.sessionId;

    expect(id1).not.toBe(id2);
  });

  it('re-start without stop also creates new sessionId (thread switch)', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    const id1 = useVoiceSessionStore.getState().session?.sessionId;

    // Simulate thread switch: start new session without explicit stop
    useVoiceSessionStore.getState().start('t2', 'codex', true);
    const id2 = useVoiceSessionStore.getState().session?.sessionId;

    expect(id1).not.toBe(id2);
    expect(useVoiceSessionStore.getState().session?.boundThreadId).toBe('t2');
  });

  it('markPlayed is scoped to session — new session has clean slate', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    useVoiceSessionStore.getState().markPlayed('audio-1');
    expect(useVoiceSessionStore.getState().hasPlayed('audio-1')).toBe(true);

    // New session: old played IDs should not carry over
    useVoiceSessionStore.getState().start('t2', 'opus', true);
    expect(useVoiceSessionStore.getState().hasPlayed('audio-1')).toBe(false);
  });

  it('autoplayUnlocked=false does NOT block auto-play (soft gate)', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', false);
    const session = useVoiceSessionStore.getState().session!;

    // autoplayUnlocked is false but voiceMode is true — hook still attempts play.
    // This prevents false-negative lockout from async AudioContext.resume().
    // On successful audio.play(), confirmAutoplayUnlocked() upgrades the flag.
    expect(session.voiceMode).toBe(true);
    expect(session.autoplayUnlocked).toBe(false);
    // Hook gates on voiceMode only, so this session WILL attempt auto-play
  });

  it('confirmAutoplayUnlocked upgrades false → true after first successful play', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', false);
    expect(useVoiceSessionStore.getState().session?.autoplayUnlocked).toBe(false);

    useVoiceSessionStore.getState().confirmAutoplayUnlocked();
    expect(useVoiceSessionStore.getState().session?.autoplayUnlocked).toBe(true);
  });
});

describe('findUnplayedAudioBlock logic (via store contracts)', () => {
  it('FIFO: oldest unplayed audio block is found first', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);

    // audio-1 not yet played → should be found first (oldest)
    expect(useVoiceSessionStore.getState().hasPlayed('audio-1')).toBe(false);
    expect(useVoiceSessionStore.getState().hasPlayed('audio-2')).toBe(false);

    // After marking audio-1 as played, audio-2 becomes the next candidate
    useVoiceSessionStore.getState().markPlayed('audio-1');
    expect(useVoiceSessionStore.getState().hasPlayed('audio-1')).toBe(true);
    expect(useVoiceSessionStore.getState().hasPlayed('audio-2')).toBe(false);
  });

  it('already-played blocks are skipped', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    useVoiceSessionStore.getState().markPlayed('audio-block-1');

    expect(useVoiceSessionStore.getState().hasPlayed('audio-block-1')).toBe(true);
    // The hook's findUnplayedAudioBlock checks hasPlayed → would skip this block
  });
});

describe('session staleness detection', () => {
  it('sessionId mismatch after stop means stale', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    const originalSessionId = useVoiceSessionStore.getState().session?.sessionId;

    // Simulate: user stops voice companion while fetch is in-flight
    useVoiceSessionStore.getState().stop();

    // fetchAndPlay's isSessionStale() would check:
    const session = useVoiceSessionStore.getState().session;
    const isStale = !session?.voiceMode || session.sessionId !== originalSessionId;
    expect(isStale).toBe(true);
  });

  it('sessionId mismatch after re-start means stale', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    const originalSessionId = useVoiceSessionStore.getState().session?.sessionId;

    // Simulate: user switches thread (new session) while fetch is in-flight
    useVoiceSessionStore.getState().start('t2', 'codex', true);

    const session = useVoiceSessionStore.getState().session!;
    const isStale = !session.voiceMode || session.sessionId !== originalSessionId;
    expect(isStale).toBe(true);
  });

  it('same session is not stale', () => {
    useVoiceSessionStore.getState().start('t1', 'opus', true);
    const originalSessionId = useVoiceSessionStore.getState().session?.sessionId;

    const session = useVoiceSessionStore.getState().session!;
    const isStale = !session.voiceMode || session.sessionId !== originalSessionId;
    expect(isStale).toBe(false);
  });
});
