/**
 * F229 PR-A3b: conciergeStore ball position tests
 *
 * Covers INV-P1 through INV-P4:
 *   P1: drag/click disambiguation — isDragging state management
 *   P2: viewport clamping (tested at ConciergeHost level, not store)
 *   P3: persist via config PUT (optimistic update + API call)
 *   P4: muted→unmuted position retained (position in config, survives mute cycle)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// mock apiFetch
// ---------------------------------------------------------------------------

vi.mock('../../utils/api-client', () => ({
  apiFetch: vi.fn(),
  API_URL: 'http://localhost:3003',
  resolveApiUrl: () => 'http://localhost:3003',
}));

import { apiFetch } from '../../utils/api-client';
import { useConciergeStore } from '../conciergeStore';

const mockApiFetch = vi.mocked(apiFetch);

function mockOk(body: unknown = {}): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Reset store between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiFetch.mockReset();
  // Reset store to initial state
  useConciergeStore.setState({
    ballPosition: null,
    isDragging: false,
    configLoaded: false,
    configLoading: false,
    configFailed: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Ball position state
// ---------------------------------------------------------------------------

describe('ballPosition initial state', () => {
  it('starts with null (default bottom-right)', () => {
    expect(useConciergeStore.getState().ballPosition).toBeNull();
  });

  it('starts with isDragging=false', () => {
    expect(useConciergeStore.getState().isDragging).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-P1: drag/click disambiguation
// ---------------------------------------------------------------------------

describe('INV-P1: setIsDragging', () => {
  it('sets isDragging to true', () => {
    useConciergeStore.getState().setIsDragging(true);
    expect(useConciergeStore.getState().isDragging).toBe(true);
  });

  it('sets isDragging to false', () => {
    useConciergeStore.getState().setIsDragging(true);
    useConciergeStore.getState().setIsDragging(false);
    expect(useConciergeStore.getState().isDragging).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-P3: setBallPosition persists via config PUT
// ---------------------------------------------------------------------------

describe('INV-P3: setBallPosition', () => {
  it('updates position optimistically', async () => {
    mockApiFetch.mockReturnValue(mockOk({ config: { ballPosition: { x: 100, y: 200 } } }));
    await useConciergeStore.getState().setBallPosition({ x: 100, y: 200 });
    expect(useConciergeStore.getState().ballPosition).toEqual({ x: 100, y: 200 });
  });

  it('calls PUT /api/concierge/config with ballPosition', async () => {
    mockApiFetch.mockReturnValue(mockOk({ config: {} }));
    await useConciergeStore.getState().setBallPosition({ x: 50, y: 75 });

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/concierge/config',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ ballPosition: { x: 50, y: 75 } }),
      }),
    );
  });

  it('does NOT reset isDragging (click handler does that)', async () => {
    mockApiFetch.mockReturnValue(mockOk({ config: {} }));
    useConciergeStore.getState().setIsDragging(true);
    await useConciergeStore.getState().setBallPosition({ x: 100, y: 200 });
    // isDragging should still be true — ConciergeBall.onClick resets it
    expect(useConciergeStore.getState().isDragging).toBe(true);
  });

  it('retains position on PUT failure (silent failure)', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));
    await useConciergeStore.getState().setBallPosition({ x: 300, y: 400 });
    // Position stays — write failure is silent (INV-P3)
    expect(useConciergeStore.getState().ballPosition).toEqual({ x: 300, y: 400 });
  });

  it('skips redundant set() when position is already current (drag-stop equality guard)', async () => {
    mockApiFetch.mockReturnValue(mockOk({ config: {} }));

    // Simulate flushSync pre-set (what ConciergeHost.handleDragStop does)
    useConciergeStore.setState({ ballPosition: { x: 42, y: 84 } });
    const posBeforeCall = useConciergeStore.getState().ballPosition;

    // setBallPosition with same values — should NOT overwrite with new object
    await useConciergeStore.getState().setBallPosition({ x: 42, y: 84 });
    const posAfterCall = useConciergeStore.getState().ballPosition;

    // Same reference (set() was skipped, not called with a new object)
    expect(posAfterCall).toBe(posBeforeCall);
    // API call still fires (persist is the purpose)
    expect(mockApiFetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// INV-P4: muted→unmuted position retained
// ---------------------------------------------------------------------------

describe('INV-P4: position survives mute cycle', () => {
  it('ball position persists through mute + unmute', async () => {
    mockApiFetch.mockReturnValue(mockOk({ config: {} }));

    // Set position
    await useConciergeStore.getState().setBallPosition({ x: 150, y: 250 });

    // Mute
    await useConciergeStore.getState().setMuted(true);
    expect(useConciergeStore.getState().ballPosition).toEqual({ x: 150, y: 250 });

    // Unmute
    await useConciergeStore.getState().setMuted(false);
    expect(useConciergeStore.getState().ballPosition).toEqual({ x: 150, y: 250 });
  });
});

// ---------------------------------------------------------------------------
// fetchConfig loads ballPosition
// ---------------------------------------------------------------------------

describe('fetchConfig loads ballPosition', () => {
  it('loads persisted ball position from config', async () => {
    mockApiFetch.mockReturnValue(
      mockOk({
        config: {
          enabled: true,
          muted: false,
          displayName: '猫猫球',
          personaTone: '温暖',
          dutyCatProfileId: 'opus',
          proactivePolicy: 'quiet-badge',
          skin: 'ragdoll-v1',
          ballPosition: { x: 42, y: 84 },
        },
      }),
    );

    await useConciergeStore.getState().fetchConfig();
    expect(useConciergeStore.getState().ballPosition).toEqual({ x: 42, y: 84 });
  });

  it('defaults to null when config has no ballPosition', async () => {
    mockApiFetch.mockReturnValue(
      mockOk({
        config: {
          enabled: true,
          muted: false,
          displayName: '猫猫球',
          personaTone: '温暖',
          dutyCatProfileId: 'opus',
          proactivePolicy: 'quiet-badge',
          skin: 'ragdoll-v1',
          // no ballPosition field
        },
      }),
    );

    await useConciergeStore.getState().fetchConfig();
    expect(useConciergeStore.getState().ballPosition).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R-review P1 fix: relay state machine (onRelayDispatching / onRelayFailed)
// ---------------------------------------------------------------------------

describe('relay state machine (R-review P1 fix)', () => {
  beforeEach(() => {
    useConciergeStore.setState({
      pendingRelayCount: 0,
      unseenResultCount: 0,
      enabled: true,
      muted: false,
      invocationStatus: 'idle',
      pendingConfirmationCount: 0,
      surfaceState: 'collapsed',
      inputFocused: false,
    });
  });

  it('onRelayDispatching increments pendingRelayCount', () => {
    useConciergeStore.getState().onRelayDispatching();
    expect(useConciergeStore.getState().pendingRelayCount).toBe(1);
  });

  it('onRelayDispatching stacks for multiple concurrent relays', () => {
    useConciergeStore.getState().onRelayDispatching();
    useConciergeStore.getState().onRelayDispatching();
    expect(useConciergeStore.getState().pendingRelayCount).toBe(2);
  });

  it('onRelayDispatched decrements pendingRelayCount WITHOUT incrementing unseenResultCount', () => {
    // R-review R3: dispatch success → handoff → idle (NOT found).
    // Spec §0: found badge waits for target cat's cross_post reply.
    useConciergeStore.getState().onRelayDispatching();
    useConciergeStore.getState().onRelayDispatched();
    expect(useConciergeStore.getState().pendingRelayCount).toBe(0);
    expect(useConciergeStore.getState().unseenResultCount).toBe(0);
  });

  it('onRelayReceived (Phase B) decrements pendingRelayCount AND increments unseenResultCount', () => {
    useConciergeStore.getState().onRelayDispatching();
    useConciergeStore.getState().onRelayReceived();
    expect(useConciergeStore.getState().pendingRelayCount).toBe(0);
    expect(useConciergeStore.getState().unseenResultCount).toBe(1);
  });

  it('onRelayFailed decrements pendingRelayCount WITHOUT incrementing unseenResultCount', () => {
    useConciergeStore.getState().onRelayDispatching();
    useConciergeStore.getState().onRelayFailed();
    expect(useConciergeStore.getState().pendingRelayCount).toBe(0);
    expect(useConciergeStore.getState().unseenResultCount).toBe(0);
  });

  it('onRelayFailed floors pendingRelayCount at 0 (defensive)', () => {
    // Edge case: onRelayFailed called without prior onRelayDispatching
    useConciergeStore.getState().onRelayFailed();
    expect(useConciergeStore.getState().pendingRelayCount).toBe(0);
  });

  it('Phase A lifecycle: dispatching → handoff → dispatched → idle (no found)', async () => {
    // In Phase A, dispatch success exits handoff to idle — NOT found.
    // found badge only appears when the actual reply arrives (Phase B).
    const { projectBallState } = await import('../conciergeStore');
    const getInputs = () => {
      const s = useConciergeStore.getState();
      return {
        enabled: s.enabled,
        muted: s.muted,
        invocationStatus: s.invocationStatus,
        pendingConfirmationCount: s.pendingConfirmationCount,
        pendingRelayCount: s.pendingRelayCount,
        unseenResultCount: s.unseenResultCount,
        surfaceState: s.surfaceState,
        inputFocused: s.inputFocused,
      };
    };

    // Start: idle
    expect(projectBallState(getInputs())).toBe('idle');

    // Dispatching: enters handoff
    useConciergeStore.getState().onRelayDispatching();
    expect(projectBallState(getInputs())).toBe('handoff');

    // Dispatched: exits handoff → idle (NOT found — spec §0)
    useConciergeStore.getState().onRelayDispatched();
    expect(projectBallState(getInputs())).toBe('idle');
    expect(useConciergeStore.getState().unseenResultCount).toBe(0);
  });

  it('Phase B lifecycle: dispatching → handoff → received → found → seen → idle', async () => {
    // Phase B: when target cat's reply arrives, found badge shows.
    const { projectBallState } = await import('../conciergeStore');
    const getInputs = () => {
      const s = useConciergeStore.getState();
      return {
        enabled: s.enabled,
        muted: s.muted,
        invocationStatus: s.invocationStatus,
        pendingConfirmationCount: s.pendingConfirmationCount,
        pendingRelayCount: s.pendingRelayCount,
        unseenResultCount: s.unseenResultCount,
        surfaceState: s.surfaceState,
        inputFocused: s.inputFocused,
      };
    };

    // Dispatching: enters handoff
    useConciergeStore.getState().onRelayDispatching();
    expect(projectBallState(getInputs())).toBe('handoff');

    // Reply arrives (Phase B message detection) → found
    useConciergeStore.getState().onRelayReceived();
    expect(projectBallState(getInputs())).toBe('found');

    // Mark seen: back to idle
    useConciergeStore.getState().markResultsSeen();
    expect(projectBallState(getInputs())).toBe('idle');
  });

  it('full lifecycle: dispatching → handoff → failed → idle (no found)', async () => {
    const { projectBallState } = await import('../conciergeStore');
    const getInputs = () => {
      const s = useConciergeStore.getState();
      return {
        enabled: s.enabled,
        muted: s.muted,
        invocationStatus: s.invocationStatus,
        pendingConfirmationCount: s.pendingConfirmationCount,
        pendingRelayCount: s.pendingRelayCount,
        unseenResultCount: s.unseenResultCount,
        surfaceState: s.surfaceState,
        inputFocused: s.inputFocused,
      };
    };

    // Start: idle
    expect(projectBallState(getInputs())).toBe('idle');

    // Dispatching: enters handoff
    useConciergeStore.getState().onRelayDispatching();
    expect(projectBallState(getInputs())).toBe('handoff');

    // Failed: exits handoff, does NOT enter found
    useConciergeStore.getState().onRelayFailed();
    expect(projectBallState(getInputs())).toBe('idle');
  });
});
