/**
 * F233 Phase C C3 — Cloud round 5 P2 regression: TrajectoryPanel stale-response race.
 *
 * Scenario: user picks F188, then quickly picks F233 before F188 fetch resolves.
 * The F188 response (older, slower) MUST be discarded — F233 (newer) must win.
 *
 * Before fix: the older response's `setProjection(F188Data)` overwrote the
 * newer F233 selection, rendering F188 data while header said F233.
 * After fix: a monotonic request id (requestIdRef) tracks the latest in-flight
 * call; stale responses early-return before touching state.
 */

import type { FeatTrajectoryProjection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock useChatStore (the panel only uses setCurrentThread for the jump-to-thread
// path that the race test doesn't exercise — stub it).
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { setCurrentThread: (id: string) => void }) => unknown) =>
    selector({ setCurrentThread: () => {} }),
}));

// Mock apiFetch with deferred-promise control: each call grabs a slot we can
// resolve/reject in any order.
type DeferredCall = {
  url: string;
  resolve: (value: { ok: boolean; status?: number; json: () => Promise<unknown> }) => void;
};
const deferred: DeferredCall[] = [];

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn((url: string) => {
    return new Promise((resolve) => {
      deferred.push({ url, resolve });
    });
  }),
}));

/**
 * Build a fetch-Response stub whose json() is a separately-controllable
 * deferred. Lets tests simulate the SECOND async boundary (body parse) and
 * exercise the race window between `await apiFetch()` resolving and
 * `await res.json()` resolving — the gap 砚砚's final-SHA review flagged.
 */
function makeDeferredJsonResponse() {
  let resolveJson!: (value: unknown) => void;
  const jsonPromise = new Promise<unknown>((resolve) => {
    resolveJson = resolve;
  });
  const response = {
    ok: true,
    status: 200,
    json: () => jsonPromise,
  };
  return { response, resolveJson };
}

// Import the panel AFTER mocks are set up
const { TrajectoryPanel } = await import('../TrajectoryPanel');

function makeProj(featId: string): FeatTrajectoryProjection {
  return {
    featId,
    entries: [
      {
        entryId: `${featId}:1`,
        subjectKey: `feat:${featId}`,
        featId,
        at: 1_700_000_000_000,
        kind: 'branch_pushed',
        source: 'git-ref-snapshot',
        payload: {},
      },
    ],
    countsBySource: { 'event-stream': 0, 'historical-stitched': 0, 'git-ref-snapshot': 1 },
    countsByKind: { branch_pushed: 1 },
    appliedEntryCount: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  deferred.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flushMicrotasks() {
  // Let pending state updates settle
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TrajectoryPanel race guard (cloud round 5 P2)', () => {
  // Note: the obvious "user picks F188 → quickly picks F233 → stale F188 resolves
  // last" UI flow is fragile to test through React+jsdom because re-opening the
  // search picker between picks requires precise focus/blur timing. The
  // clear-button case below exercises the same `requestIdRef` guard path
  // (load → in-flight → discard) without the picker-state dance, so it gives
  // equivalent regression coverage for the underlying mechanism. The end-to-end
  // multi-pick race is covered by manual smoke (`pnpm alpha:start` → pick F188
  // → throttle network → quickly pick F233 → confirm header == F233 stays).

  it('clearing selection bumps request id so a late response cannot repopulate projection', async () => {
    act(() => {
      root.render(<TrajectoryPanel />);
    });
    await flushMicrotasks();

    // Bootstrap feat list
    await act(async () => {
      deferred[0].resolve({ ok: true, status: 200, json: async () => ({ feats: ['F188'] }) });
    });
    deferred.length = 0;

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      input.focus();
    });
    const f188Button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'F188',
    ) as HTMLButtonElement;
    await act(async () => {
      f188Button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushMicrotasks();

    const f188Deferred = deferred[0];
    deferred.length = 0;

    // Now click the clear button (✕). After that, the in-flight F188 should be
    // discarded when it resolves.
    const clearBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '✕') as
      | HTMLButtonElement
      | undefined;
    expect(clearBtn, 'clear button should be visible after selection').toBeTruthy();
    await act(async () => {
      clearBtn?.click();
    });
    await flushMicrotasks();

    // Resolve F188 — should be discarded (clear bumped request id)
    await act(async () => {
      f188Deferred.resolve({ ok: true, status: 200, json: async () => makeProj('F188') });
    });
    await flushMicrotasks();

    // No selected header should be present
    const selectedHeader = container.querySelector('.text-conn-purple-text.font-semibold');
    expect(selectedHeader).toBeNull();
  });

  it('砚砚 final-SHA P2: stale json() resolution after clear is also discarded (second async boundary)', async () => {
    // The first race-guard test resolves the apiFetch with a pre-resolved
    // json(). The real-world race has TWO async boundaries: (a) network
    // round-trip, (b) body parse / res.json(). If the user clears between
    // those, the guard must fire after json() too — not just after apiFetch.
    act(() => {
      root.render(<TrajectoryPanel />);
    });
    await flushMicrotasks();

    // Bootstrap feat list
    await act(async () => {
      deferred[0].resolve({ ok: true, status: 200, json: async () => ({ feats: ['F188'] }) });
    });
    deferred.length = 0;

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      input.focus();
    });
    const f188Button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'F188',
    ) as HTMLButtonElement;
    await act(async () => {
      f188Button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushMicrotasks();

    // Resolve apiFetch with a Response whose json() is a SEPARATELY-CONTROLLED
    // deferred. apiFetch promise settles, but the body parse is still pending.
    const { response, resolveJson } = makeDeferredJsonResponse();
    const f188Deferred = deferred[0];
    deferred.length = 0;
    await act(async () => {
      f188Deferred.resolve(response);
    });
    await flushMicrotasks();
    // At this point: code has passed the FIRST guard (after apiFetch), but is
    // still awaiting json(). The body is in-flight.

    // User clears the selection while json() is still pending.
    const clearBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '✕') as
      | HTMLButtonElement
      | undefined;
    expect(clearBtn, 'clear button should be visible mid-flight').toBeTruthy();
    await act(async () => {
      clearBtn?.click();
    });
    await flushMicrotasks();

    // NOW resolve json(). If the guard only ran after apiFetch (the bug),
    // this would call setProjection(F188Data) on the cleared state. With the
    // SECOND guard (after json()) it must be discarded.
    await act(async () => {
      resolveJson(makeProj('F188'));
    });
    await flushMicrotasks();

    // Selection should still be cleared — no header, no projection.
    const selectedHeader = container.querySelector('.text-conn-purple-text.font-semibold');
    expect(selectedHeader, 'no selected feat after clear; stale body parse must not repopulate').toBeNull();
  });
});
