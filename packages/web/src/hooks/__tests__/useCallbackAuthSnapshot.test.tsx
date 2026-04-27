/**
 * F174 D2b-2 — pure-unit tests for the snapshot derivation logic.
 *
 * Covers `deriveByCat` thresholds (healthy / degraded / broken). The hook's
 * fetch + polling lifecycle is exercised through HubCallbackAuthPanel
 * integration in alpha rather than React-Testing-Library here (this package
 * doesn't bring @testing-library/react).
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { type CallbackAuthSnapshot, deriveByCat, useCallbackAuthSnapshot } from '../useCallbackAuthSnapshot';

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => (globalThis as { __apiFetch?: (...a: unknown[]) => unknown }).__apiFetch?.(...args),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

const baseSnapshot: CallbackAuthSnapshot = {
  reasonCounts: { expired: 0, invalid_token: 0, unknown_invocation: 0, stale_invocation: 0, missing_creds: 0 },
  toolCounts: {},
  byCat: {},
  recentSamples: [],
  totalFailures: 0,
  startedAt: 0,
  uptimeMs: 0,
  recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
};

describe('deriveByCat (F174 D2b-2 status thresholds)', () => {
  it('returns empty when snapshot is null', () => {
    expect(deriveByCat(null)).toEqual({});
  });

  it('classifies 0 failures as healthy', () => {
    const result = deriveByCat({ ...baseSnapshot, recent24h: { ...baseSnapshot.recent24h, byCat: { opus: 0 } } });
    expect(result.opus.status).toBe('healthy');
    expect(result.opus.failures24h).toBe(0);
  });

  it('classifies 1-5 failures as degraded', () => {
    const result = deriveByCat({
      ...baseSnapshot,
      recent24h: { ...baseSnapshot.recent24h, byCat: { opus: 1, codex: 5 } },
    });
    expect(result.opus.status).toBe('degraded');
    expect(result.codex.status).toBe('degraded');
  });

  it('classifies 6+ failures as broken', () => {
    const result = deriveByCat({
      ...baseSnapshot,
      recent24h: { ...baseSnapshot.recent24h, byCat: { opus: 6, codex: 100 } },
    });
    expect(result.opus.status).toBe('broken');
    expect(result.codex.status).toBe('broken');
  });

  it('Cloud P2 #1403 (round 8): stops polling on first 401/403 (non-owner zero-traffic latch)', async () => {
    // Cloud's verdict: indefinite backoff still wastes traffic for non-owner.
    // Latch on first 401/403 → no further polls until manual refetch.
    const fetchStub = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
    (globalThis as { __apiFetch?: unknown }).__apiFetch = fetchStub;
    vi.useFakeTimers();
    function Probe() {
      useCallbackAuthSnapshot({ pollIntervalMs: 100 });
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // Advance well past any plausible interval — count must STAY at 1.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('砚砚 P1 #1403: in-flight fetch resolved AFTER unmount does NOT re-arm timer', async () => {
    // Reproduces the lifecycle race: mount → fetch starts → unmount → fetch
    // resolves → without the generation guard, fetchAndReschedule would
    // setTimeout a new poll. With the guard, post-unmount resolution is a no-op.
    let resolveFirst: ((v: unknown) => void) | undefined;
    const fetchStub = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    (globalThis as { __apiFetch?: unknown }).__apiFetch = fetchStub;
    vi.useFakeTimers();
    function Probe() {
      useCallbackAuthSnapshot({ pollIntervalMs: 100 });
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // Unmount BEFORE the in-flight fetch resolves.
    await act(async () => {
      root.unmount();
    });
    container.remove();
    // Now resolve the in-flight fetch — without the guard, this would
    // setTimeout a new poll. With the guard, it returns early.
    await act(async () => {
      resolveFirst?.({ ok: true, status: 200, json: async () => ({ ...baseSnapshot }) });
      await Promise.resolve();
      await Promise.resolve();
    });
    // Advance well past any plausible poll interval — count must stay at 1.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('Cloud P2 #1403 (round 8): refetch() clears auth-blocked latch so manual retry can recover', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...baseSnapshot }) });
    (globalThis as { __apiFetch?: unknown }).__apiFetch = fetchStub;
    vi.useFakeTimers();
    let capturedRefetch: (() => void) | undefined;
    function Probe() {
      const r = useCallbackAuthSnapshot({ pollIntervalMs: 100 });
      capturedRefetch = r.refetch;
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // First: 403 → latch flips, no more auto-polls.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // Manual refetch() clears the latch + re-fires fetch.
    await act(async () => {
      capturedRefetch?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    // After success, polling resumes at base interval.
    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(fetchStub.mock.calls.length).toBeGreaterThanOrEqual(3);
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('handles mixed-status cohort', () => {
    const result = deriveByCat({
      ...baseSnapshot,
      recent24h: { ...baseSnapshot.recent24h, byCat: { opus: 0, codex: 3, gemini: 99 } },
    });
    expect(result.opus.status).toBe('healthy');
    expect(result.codex.status).toBe('degraded');
    expect(result.gemini.status).toBe('broken');
  });
});
