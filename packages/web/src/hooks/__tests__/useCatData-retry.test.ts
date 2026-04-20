/**
 * F32-b Phase 3: Regression test for useCatData in-session retry mechanism.
 *
 * Verifies: first fetch fails → 10s timer → retry succeeds →
 *           cats updated from fallback to API data → no further retries.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@cat-cafe/shared', () => ({
  CAT_CONFIGS: {
    opus: {
      id: 'opus',
      displayName: '布偶猫',
      nickname: '宪宪',
      color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
      mentionPatterns: ['@布偶', '@布偶猫', '@opus'],
      clientId: 'anthropic',
      defaultModel: 'opus',
      avatar: '/a.png',
      roleDescription: 'dev',
      personality: 'kind',
    },
  },
}));

vi.mock('@/lib/mention-highlight', () => ({ refreshMentionData: vi.fn() }));
vi.mock('@/utils/transcription-corrector', () => ({ refreshSpeechAliases: vi.fn() }));

import type { CatData } from '@/hooks/useCatData';
import { _resetCatDataCache, useCatData } from '@/hooks/useCatData';

// ── API response cats (distinguishable from fallback via breedId) ──

const API_CATS = [
  {
    id: 'opus',
    displayName: '布偶猫',
    nickname: '宪宪',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['@布偶', '@布偶猫', '@opus'],
    breedId: 'ragdoll',
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4',
    avatar: '/avatars/opus.png',
    roleDescription: '主架构师',
    personality: '温柔有主见',
    source: 'seed',
    roster: {
      family: 'ragdoll',
      roles: ['architect', 'peer-reviewer'],
      lead: true,
      available: true,
      evaluation: 'seed lead',
    },
  },
  {
    id: 'codex',
    displayName: '缅因猫',
    nickname: '砚砚',
    color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
    mentionPatterns: ['@缅因', '@缅因猫', '@codex'],
    breedId: 'maine-coon',
    clientId: 'openai',
    defaultModel: 'codex-mini',
    avatar: '/avatars/codex.png',
    roleDescription: '代码审查',
    personality: '严格',
    source: 'runtime',
    roster: null,
  },
];

// ── Test harness ───────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof useCatData>;
let hookResultA: ReturnType<typeof useCatData>;
let hookResultB: ReturnType<typeof useCatData>;

function TestComponent() {
  hookResult = useCatData();
  return null;
}

function MultiHookComponent() {
  hookResultA = useCatData();
  hookResultB = useCatData();
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  vi.useFakeTimers();
  _resetCatDataCache();
  mockApiFetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

// ── Tests ──────────────────────────────────────────────────

describe('useCatData retry mechanism', () => {
  it('retries after 10s on failure and stops after success', async () => {
    // F166: /api/config/cat-order always returns empty order; /api/cats follows
    // the retry sequence (fail → success).
    const catsResponses = [{ ok: false }, { ok: true, json: () => Promise.resolve({ cats: API_CATS }) }];
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config/cat-order') return Promise.resolve({ ok: false });
      return Promise.resolve(catsResponses.shift() ?? { ok: false });
    });

    // Render — triggers first fetchCats()
    await act(async () => {
      root.render(React.createElement(TestComponent));
    });

    const catsCallCount = () => mockApiFetch.mock.calls.filter((call) => call[0] === '/api/cats').length;

    // First fetch resolved (failure) → fallback cats, no breedId
    expect(hookResult.isLoading).toBe(false);
    expect(hookResult.cats[0].id).toBe('opus');
    expect(hookResult.cats[0].breedId).toBeUndefined(); // fallback marker
    expect((hookResult.cats[0] as CatData & { source?: string }).source).toBe('seed');
    expect((hookResult.cats[0] as CatData & { roster?: unknown }).roster ?? null).toBeNull();
    expect(catsCallCount()).toBe(1);

    // Advance 10s → retry timer fires → retryCount increments → re-fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Second fetch resolved (success) → API cats with breedId
    expect(hookResult.cats).toHaveLength(2);
    expect(hookResult.cats[0].breedId).toBe('ragdoll');
    expect(hookResult.cats[1].id).toBe('codex');
    expect((hookResult.cats[0] as CatData & { source?: string }).source).toBe('seed');
    expect((hookResult.cats[0] as CatData & { roster?: { lead?: boolean } | null }).roster?.lead).toBe(true);
    expect((hookResult.cats[1] as CatData & { source?: string }).source).toBe('runtime');
    expect((hookResult.cats[1] as CatData & { roster?: unknown }).roster ?? null).toBeNull();
    expect(catsCallCount()).toBe(2);

    // Advance another 30s → no further retries (success stops the cycle)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(catsCallCount()).toBe(2);
  });

  it('stops retrying after MAX_RETRIES (3) failures', async () => {
    // All calls fail (both /api/cats and /api/config/cat-order)
    mockApiFetch.mockResolvedValue({ ok: false });

    await act(async () => {
      root.render(React.createElement(TestComponent));
    });

    const catsCallCount = () => mockApiFetch.mock.calls.filter((call) => call[0] === '/api/cats').length;

    // Initial fetch = call #1
    expect(catsCallCount()).toBe(1);

    // Retry 1 (10s), Retry 2 (20s), Retry 3 (30s)
    for (let i = 1; i <= 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(catsCallCount()).toBe(1 + i);
    }

    // No retry #4 — MAX_RETRIES reached
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(catsCallCount()).toBe(4); // 1 initial + 3 retries
  });

  it('refresh updates all mounted hook consumers, not only the caller', async () => {
    const initialCats = [
      {
        id: 'opus',
        displayName: '布偶猫',
        mentionPatterns: ['@opus'],
        clientId: 'anthropic',
        defaultModel: 'claude-opus-4',
        avatar: '/a.png',
        roleDescription: 'dev',
        personality: 'kind',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        source: 'seed',
      },
    ];
    const refreshedCats = [
      ...initialCats,
      {
        id: 'codex',
        displayName: '缅因猫',
        mentionPatterns: ['@codex'],
        clientId: 'openai',
        defaultModel: 'gpt-5.4',
        avatar: '/b.png',
        roleDescription: 'review',
        personality: 'rigorous',
        color: { primary: '#4A90E2', secondary: '#E6F2FF' },
        source: 'runtime',
      },
    ];
    const catsResponses = [
      { ok: true, json: () => Promise.resolve({ cats: initialCats }) },
      { ok: true, json: () => Promise.resolve({ cats: refreshedCats }) },
    ];
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config/cat-order') return Promise.resolve({ ok: false } as Response);
      return Promise.resolve((catsResponses.shift() ?? { ok: false }) as Response);
    });

    await act(async () => {
      root.render(React.createElement(MultiHookComponent));
    });
    await flushPromises();
    expect(hookResultA.cats).toHaveLength(1);
    expect(hookResultB.cats).toHaveLength(1);

    await act(async () => {
      await hookResultA.refresh();
    });

    expect(hookResultA.cats).toHaveLength(2);
    expect(hookResultB.cats).toHaveLength(2);
  });
});

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}
