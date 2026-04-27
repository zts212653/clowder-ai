/**
 * F174 D2b-2 — cloud Codex P1 #1403 regression: CallbackAuthCatAvatar must
 * render a status dot for cats with NO failure record, because the backend
 * snapshot's recent24h.byCat ONLY contains cats that had failures (it's
 * populated in recordCallbackAuthFailure). Without this fix, every healthy
 * cat looked unmonitored — the "always-visible per-cat state" promise of
 * D2b-2 was broken in the common case.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      id: 'opus',
      displayName: 'Opus',
      avatar: '/avatars/opus.png',
      color: { primary: '#9CA3AF' },
    }),
    cats: [],
    refresh: () => {},
  }),
}));

let mockByCat: Record<string, { status: 'healthy' | 'degraded' | 'broken'; failures24h: number }> = {};
let mockAvailable = false;

vi.mock('@/stores/callbackAuthStore', () => ({
  useCallbackAuthByCat: (catId: string) => mockByCat[catId],
  useCallbackAuthAggregate: () => ({
    byReason: {},
    byTool: {},
    totalFailures24h: 0,
    topReasons: [],
    topTools: [],
  }),
  useCallbackAuthAvailable: () => mockAvailable,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { openHub: (...a: unknown[]) => void }) => unknown) => selector({ openHub: () => {} }),
}));

import { CallbackAuthCatAvatar } from '../CallbackAuthCatAvatar';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('CallbackAuthCatAvatar healthy-default (F174 D2b-2 cloud P1 #1403)', () => {
  it('renders no dot when snapshot is unavailable (non-owner / fetch failed)', () => {
    mockAvailable = false;
    mockByCat = {};
    const html = renderToStaticMarkup(<CallbackAuthCatAvatar catId="opus" size={48} />);
    expect(html).not.toContain('data-testid="callback-auth-dot"');
  });

  it('renders UNKNOWN dot when snapshot is available but cat has no failure record (cloud P1 #1403 round 7)', async () => {
    // Cloud Codex correction to the previous round's "default to healthy" fix:
    // backend's recent24h.byCat ONLY records failure events — absent ≠ known
    // healthy. Could be no calls at all in 24h, or successful calls without
    // failures. Conflating with healthy gives a false-green signal. We show
    // `unknown` (gray) instead so users see the difference.
    mockAvailable = true;
    mockByCat = {}; // opus is not in byCat — backend had no failure event for it
    const html = renderToStaticMarkup(<CallbackAuthCatAvatar catId="opus" size={48} />);
    expect(html).toContain('data-testid="callback-auth-dot"');
    expect(html).toContain('data-callback-auth-status="unknown"');
    // Label clarifies: "no failure record" rather than asserting healthy.
    expect(html).toContain('opus: 24h 内无失败记录');
  });

  it('renders DEGRADED dot for a cat with mid failures', () => {
    mockAvailable = true;
    mockByCat = { opus: { status: 'degraded', failures24h: 3 } };
    const html = renderToStaticMarkup(<CallbackAuthCatAvatar catId="opus" size={48} />);
    expect(html).toContain('data-callback-auth-status="degraded"');
    expect(html).toContain('opus: degraded · 3 fails (24h)');
  });

  it('renders BROKEN dot for a cat above threshold', () => {
    mockAvailable = true;
    mockByCat = { opus: { status: 'broken', failures24h: 12 } };
    const html = renderToStaticMarkup(<CallbackAuthCatAvatar catId="opus" size={48} />);
    expect(html).toContain('data-callback-auth-status="broken"');
    expect(html).toContain('opus: broken · 12 fails (24h)');
  });
});
