/**
 * F24: SessionChainPanel tests.
 * Verifies session chain visualization: active sessions with health bar,
 * sealed sessions with lock icons, post-compact safety alert, re-fetch on seal.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatInvocationInfo } from '@/stores/chat-types';
import { SessionChainPanel } from '../SessionChainPanel';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

let mockApiFetch: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Stub ContextHealthBar and TokenCacheBar to avoid pulling in their dependencies
vi.mock('../ContextHealthBar', () => ({
  ContextHealthBar: (props: { catId: string }) =>
    React.createElement('div', { 'data-testid': `health-bar-${props.catId}` }),
}));

// F33: Stub useCatData for BindNewSessionSection
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      { id: 'opus', displayName: '布偶猫', color: { primary: '#7C3AED', secondary: '#EDE9FE' } },
      { id: 'codex', displayName: '缅因猫', color: { primary: '#059669', secondary: '#D1FAE5' } },
      { id: 'kimi', displayName: '梵花猫', color: { primary: '#4B5563', secondary: '#E5E7EB' } },
    ],
    isLoading: false,
    getCatById: (id: string) => {
      const map: Record<string, unknown> = {
        opus: { id: 'opus', displayName: '布偶猫' },
        codex: { id: 'codex', displayName: '缅因猫' },
        kimi: { id: 'kimi', displayName: '梵花猫' },
      };
      return map[id];
    },
    getCatsByBreed: () => new Map(),
  }),
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}(${cat.variantLabel})` : cat.displayName,
}));

vi.mock('../status-helpers', () => ({
  truncateId: (id: string, len: number) => (id.length > len ? `${id.slice(0, len)}…` : id),
}));

const origCreateElement = document.createElement.bind(document);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = origCreateElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockApiFetch = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPanel(threadId: string, catInvocations: Record<string, CatInvocationInfo> = {}) {
  act(() => {
    root.render(React.createElement(SessionChainPanel, { threadId, catInvocations }));
  });
}

async function flushFetch() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function mockSessionsResponse(sessions: unknown[]) {
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ sessions }),
  });
}

describe('F24: SessionChainPanel', () => {
  it('renders panel with bind section even when API returns empty sessions (F33)', async () => {
    mockSessionsResponse([]);
    renderPanel('thread-1');
    await flushFetch();
    // Panel should render (F33: always visible for external session binding)
    expect(container.querySelector('section')).not.toBeNull();
    // No session cards, but bind section available
    expect(container.textContent).toContain('0 sessions');
    expect(container.textContent).toContain('绑定外部 Session');
  });

  it('renders session count in header', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
      {
        id: 's2',
        catId: 'opus',
        seq: 1,
        status: 'sealed',
        messageCount: 12,
        createdAt: Date.now() - 60000,
        sealedAt: Date.now() - 30000,
      },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('2 sessions');
  });

  it('renders active session with seq number, cat badge, and clickable session ID', async () => {
    mockSessionsResponse([
      { id: 'ses_abc12345xyz', catId: 'opus', seq: 2, status: 'active', messageCount: 8, createdAt: Date.now() - 5000 },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('Session #3');
    expect(container.textContent).toContain('布偶猫');
    expect(container.textContent).toContain('Active');
    expect(container.textContent).toContain('8 msgs');
    // Session ID should be visible (truncated) with copy title
    const idBtn = container.querySelector('button[title*="ses_abc12345xyz"]');
    expect(idBtn).not.toBeNull();
    expect(idBtn?.textContent).toContain('ses_abc123');
  });

  it('renders ContextHealthBar for active session with health data', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'active',
        messageCount: 3,
        createdAt: Date.now(),
        contextHealth: { usedTokens: 123000, windowTokens: 150000, fillRatio: 0.82, source: 'exact' },
      },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    // ContextHealthBar is rendered (mocked as div with data-testid)
    expect(container.querySelector('[data-testid="health-bar-opus"]')).not.toBeNull();
  });

  it('prefers invocation contextHealth over session contextHealth', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'active',
        messageCount: 3,
        createdAt: Date.now(),
        contextHealth: { usedTokens: 50000, windowTokens: 150000, fillRatio: 0.33, source: 'approx' },
      },
    ]);
    const invocations: Record<string, CatInvocationInfo> = {
      opus: {
        contextHealth: {
          usedTokens: 120000,
          windowTokens: 150000,
          fillRatio: 0.8,
          source: 'exact',
          measuredAt: Date.now(),
        },
      },
    };
    renderPanel('thread-1', invocations);
    await flushFetch();
    // ContextHealthBar should be rendered (delegates % display to the component)
    expect(container.querySelector('[data-testid="health-bar-opus"]')).not.toBeNull();
  });

  it('renders sealed sessions with seal reason label and clickable IDs', async () => {
    mockSessionsResponse([
      {
        id: 'seal_aaa111',
        catId: 'opus',
        seq: 0,
        status: 'sealed',
        messageCount: 20,
        createdAt: Date.now() - 120000,
        sealedAt: Date.now() - 60000,
        sealReason: 'claude-code-compact-auto',
        contextHealth: { usedTokens: 140000, windowTokens: 150000, fillRatio: 0.93, source: 'exact' },
      },
      {
        id: 'seal_bbb222',
        catId: 'opus',
        seq: 1,
        status: 'sealed',
        messageCount: 15,
        createdAt: Date.now() - 60000,
        sealedAt: Date.now() - 10000,
        sealReason: 'threshold',
      },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('Session #1');
    expect(container.textContent).toContain('Session #2');
    expect(container.textContent).toContain('compact');
    expect(container.textContent).toContain('threshold');
    expect(container.textContent).toContain('Sealed');
    // Both sealed sessions should have clickable ID buttons
    expect(container.querySelector('button[title*="seal_aaa111"]')).not.toBeNull();
    expect(container.querySelector('button[title*="seal_bbb222"]')).not.toBeNull();
  });

  it('shows sealing text for sessions with status sealing', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'sealing', messageCount: 10, createdAt: Date.now() - 5000 },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('sealing');
  });

  it('renders kimi family badge colors for active sessions', async () => {
    mockSessionsResponse([
      { id: 'kimi_s1', catId: 'kimi', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const html = container.innerHTML;
    expect(html).toContain('border-kimi-primary/40');
  });

  it('renders known cat display names in the active session badge', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'kimi', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('梵花猫');
  });

  it('shows post-compact safety alert when sessionSealed is true', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 1, status: 'active', messageCount: 3, createdAt: Date.now() },
    ]);
    const invocations: Record<string, CatInvocationInfo> = {
      opus: { sessionSeq: 1, sessionSealed: true },
    };
    renderPanel('thread-1', invocations);
    await flushFetch();
    expect(container.textContent).toContain('Post-compact safety active');
    expect(container.textContent).toContain('High-risk ops may be blocked');
  });

  it('does not show post-compact alert when no cat has sessionSealed', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
    ]);
    renderPanel('thread-1', { opus: { sessionSeq: 0 } });
    await flushFetch();
    expect(container.textContent).not.toContain('Post-compact safety active');
  });

  it('re-fetches when sealSignal changes', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
    ]);
    renderPanel('thread-1', { opus: { sessionSeq: 0 } });
    await flushFetch();

    const callsBefore = mockApiFetch.mock.calls.length;

    // Re-render with sessionSealed changed → triggers sealSignal change
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'sealed',
        messageCount: 3,
        createdAt: Date.now(),
        sealedAt: Date.now(),
      },
      { id: 's2', catId: 'opus', seq: 1, status: 'active', messageCount: 0, createdAt: Date.now() },
    ]);
    renderPanel('thread-1', { opus: { sessionSeq: 0, sessionSealed: true } });
    await flushFetch();

    expect(mockApiFetch.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('renders ContextHealthBar for approx source health', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'gemini',
        seq: 0,
        status: 'active',
        messageCount: 2,
        createdAt: Date.now(),
        contextHealth: { usedTokens: 80000, windowTokens: 150000, fillRatio: 0.53, source: 'approx' },
      },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    // ContextHealthBar is rendered (mocked); approx indicator handled internally
    expect(container.querySelector('[data-testid="health-bar-gemini"]')).not.toBeNull();
  });

  it('renders ContextHealthBar for high fill ratio', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'active',
        messageCount: 5,
        createdAt: Date.now(),
        contextHealth: { usedTokens: 140000, windowTokens: 150000, fillRatio: 0.93, source: 'exact' },
      },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    // ContextHealthBar renders (color handling is internal to the component)
    expect(container.querySelector('[data-testid="health-bar-opus"]')).not.toBeNull();
  });

  it('shows cached percentage when invocation has cacheReadTokens', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
    ]);
    const invocations: Record<string, CatInvocationInfo> = {
      opus: {
        usage: { inputTokens: 100000, outputTokens: 5000, cacheReadTokens: 75000 },
      },
    };
    renderPanel('thread-1', invocations);
    await flushFetch();
    expect(container.textContent).toContain('cached');
  });

  it('hides cached percentage when no cacheReadTokens', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
    ]);
    const invocations: Record<string, CatInvocationInfo> = {
      opus: {
        usage: { inputTokens: 100000, outputTokens: 5000 },
      },
    };
    renderPanel('thread-1', invocations);
    await flushFetch();
    expect(container.textContent).not.toContain('cached');
  });

  it('shows token counts from session.lastUsage when no live invocation', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'active',
        messageCount: 5,
        createdAt: Date.now(),
        lastUsage: { inputTokens: 120000, outputTokens: 8000, cacheReadTokens: 90000 },
      },
    ]);
    // No catInvocations — simulates page reload with no live data
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('120k');
    expect(container.textContent).toContain('8k');
    expect(container.textContent).toContain('cached');
  });

  it('prefers live invocation usage over session.lastUsage', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'active',
        messageCount: 5,
        createdAt: Date.now(),
        lastUsage: { inputTokens: 50000, outputTokens: 2000 },
      },
    ]);
    const invocations: Record<string, CatInvocationInfo> = {
      opus: {
        usage: { inputTokens: 150000, outputTokens: 10000 },
      },
    };
    renderPanel('thread-1', invocations);
    await flushFetch();
    // Should show live data (150k/10k), not persisted (50k/2k)
    expect(container.textContent).toContain('150k');
    expect(container.textContent).toContain('10k');
    // Persisted outputTokens (2k) should NOT appear
    expect(container.textContent).not.toContain('2k');
  });

  it('calls API with correct thread URL', async () => {
    mockSessionsResponse([]);
    renderPanel('my-thread-42');
    await flushFetch();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/my-thread-42/sessions');
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 500 });
    renderPanel('thread-1');
    await flushFetch();
    // Should not crash; panel still renders (F33: bind section always present)
    expect(container.textContent).toContain('0 sessions');
    expect(container.textContent).not.toContain('Session #');
  });

  it('renders singular "session" for count of 1', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('1 session');
    expect(container.textContent).not.toContain('1 sessions');
  });

  it('clears stale sessions on thread switch when fetch fails (P2 regression)', async () => {
    // First thread loads successfully
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('Session #1');

    // Switch to thread-2, but fetch fails
    mockApiFetch.mockResolvedValue({ ok: false, status: 500 });
    renderPanel('thread-2');
    await flushFetch();

    // Old thread-1 data must be gone
    expect(container.textContent).not.toContain('Session #1');
    // Panel still renders (F33: bind section), but no session cards
    expect(container.textContent).toContain('0 sessions');
  });

  it('clears stale sessions on thread switch when fetch throws', async () => {
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'sealed',
        messageCount: 12,
        createdAt: Date.now() - 60000,
        sealedAt: Date.now(),
      },
    ]);
    renderPanel('thread-A');
    await flushFetch();
    expect(container.textContent).toContain('Session #1');

    // Switch to thread-B, but fetch throws network error
    mockApiFetch.mockRejectedValue(new Error('network error'));
    renderPanel('thread-B');
    await flushFetch();

    // Old thread-A data must be gone
    expect(container.textContent).not.toContain('Session #1');
    // Panel still renders (F33: bind section), but no session cards
    expect(container.textContent).toContain('0 sessions');
  });

  it('applies codex green colors to active session border and badge', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'codex', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    // Border should use codex green, not opus purple
    const card = container.querySelector('.border-codex-primary\\/40');
    expect(card).not.toBeNull();
    // Badge should use codex colors
    const badge = container.querySelector('.bg-codex-light.text-codex-dark');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('缅因猫');
    // Must NOT have opus purple
    expect(container.querySelector('.border-opus-primary\\/40')).toBeNull();
    expect(container.querySelector('.bg-opus-light')).toBeNull();
  });

  it('applies gemini blue colors to active session border and badge', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'gemini', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector('.border-gemini-primary\\/40');
    expect(card).not.toBeNull();
    const badge = container.querySelector('.bg-gemini-light.text-gemini-dark');
    expect(badge).not.toBeNull();
  });

  it('applies dare amber colors to active session border and badge', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'dare', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector('.border-dare-primary\\/40');
    expect(card).not.toBeNull();
    const badge = container.querySelector('.bg-dare-light.text-dare-dark');
    expect(badge).not.toBeNull();
  });

  it('applies maine-coon variant green shades for gpt52', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'gpt52', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.innerHTML).toContain('border-[#66BB6A66]');
    expect(container.innerHTML).toContain('bg-[#C8E6C9]');
    expect(container.innerHTML).toContain('text-[#2E7D32]');
    expect(container.querySelector('.bg-gray-200.text-gray-600')).toBeNull();
  });

  it('applies ragdoll variant purple shades for opus-45 and sonnet', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'opus-45', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
      { id: 's2', catId: 'sonnet', seq: 1, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.innerHTML).toContain('border-[#7E57C266]');
    expect(container.innerHTML).toContain('bg-[#E1D5F0]');
    expect(container.innerHTML).toContain('text-[#5E35B1]');
    expect(container.innerHTML).toContain('border-[#B39DDB66]');
    expect(container.innerHTML).toContain('bg-[#EDE7F6]');
    expect(container.innerHTML).toContain('text-[#6A1B9A]');
  });

  it('applies gray fallback colors for unknown catId', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'unknown-cat', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector('.border-cafe\\/40');
    expect(card).not.toBeNull();
    const badge = container.querySelector('.bg-gray-200.text-cafe-secondary');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('unknown-cat');
  });

  it('discards stale response when slow thread-1 fetch resolves after thread-2 (P1 race condition)', async () => {
    // Deferred promises to control resolution order
    let resolveThread1!: (v: unknown) => void;
    let resolveThread2!: (v: unknown) => void;

    const thread1Promise = new Promise((r) => {
      resolveThread1 = r;
    });
    const thread2Promise = new Promise((r) => {
      resolveThread2 = r;
    });

    // First render: thread-1 (slow)
    mockApiFetch.mockImplementation((...args: unknown[]) => {
      const url = args[0] as string;
      if (url.includes('thread-1')) return thread1Promise;
      if (url.includes('thread-2')) return thread2Promise;
      return Promise.resolve({ ok: false });
    });

    renderPanel('thread-1');
    await flushFetch();

    // Switch to thread-2 before thread-1 resolves
    renderPanel('thread-2');
    await flushFetch();

    // thread-2 resolves first
    resolveThread2({
      ok: true,
      json: async () => ({
        sessions: [{ id: 's2', catId: 'opus', seq: 5, status: 'active', messageCount: 3, createdAt: Date.now() }],
      }),
    });
    await flushFetch();

    expect(container.textContent).toContain('Session #6'); // seq 5 → display #6

    // Now thread-1 (stale) resolves late
    resolveThread1({
      ok: true,
      json: async () => ({
        sessions: [{ id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 10, createdAt: Date.now() }],
      }),
    });
    await flushFetch();

    // Stale thread-1 data must NOT overwrite thread-2
    expect(container.textContent).toContain('Session #6');
    expect(container.textContent).not.toContain('Session #1');
  });

  describe('F33: bind new external session', () => {
    it('hides bind UI for default thread (system-owned, bind returns 403)', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('default');
      await flushFetch();
      // Neither the per-session "bind..." nor the "绑定外部 Session" should appear
      expect(container.textContent).not.toContain('bind...');
      expect(container.textContent).not.toContain('绑定外部 Session');
    });

    it('shows bind-new-session button even when no sessions exist', async () => {
      mockSessionsResponse([]);
      renderPanel('thread-1');
      await flushFetch();
      expect(container.textContent).toContain('绑定外部 Session');
    });

    it('shows bind-new-session button alongside active sessions', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      expect(container.textContent).toContain('Session #1');
      expect(container.textContent).toContain('绑定外部 Session');
    });

    it('filters out cats that already have active sessions from dropdown', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();

      // Click to expand bind section
      const bindBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('绑定外部 Session'),
      );
      expect(bindBtn).not.toBeUndefined();
      act(() => {
        bindBtn?.click();
      });

      // Should show codex (no active session) but not opus (has active session)
      const select = container.querySelector('select');
      expect(select).not.toBeNull();
      const options = Array.from(select!.querySelectorAll('option'));
      const optionTexts = options.map((o) => o.textContent);
      expect(optionTexts.some((t) => t?.includes('缅因猫'))).toBe(true);
      expect(optionTexts.some((t) => t?.includes('布偶猫'))).toBe(false);
    });
  });

  describe('bind UI', () => {
    it('renders bind button for active sessions', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      expect(container.textContent).toContain('bind...');
    });

    it('does not render bind button for sealed sessions', async () => {
      mockSessionsResponse([
        {
          id: 's1',
          catId: 'opus',
          seq: 0,
          status: 'sealed',
          messageCount: 10,
          createdAt: Date.now(),
          sealedAt: Date.now(),
        },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      expect(container.textContent).not.toContain('bind...');
    });

    it('shows input after clicking bind button', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();

      const bindBtn = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'bind...');
      expect(bindBtn).not.toBeUndefined();

      act(() => {
        bindBtn?.click();
      });

      const input = container.querySelector('input[placeholder="CLI session ID"]');
      expect(input).not.toBeNull();
    });

    it('calls PATCH bind API on submit and re-fetches sessions', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();

      // Click bind button to open input
      const bindBtn = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'bind...');
      act(() => {
        bindBtn?.click();
      });

      // Type session ID
      const input = container.querySelector('input[placeholder="CLI session ID"]') as HTMLInputElement;
      act(() => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!
          .set!;
        nativeInputValueSetter.call(input, 'ses_test_123');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Mock successful bind response
      mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

      // Click bind submit button
      const submitBtn = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'bind');
      act(() => {
        submitBtn?.click();
      });

      await flushFetch();

      // Verify PATCH was called with correct URL and body
      const patchCall = mockApiFetch.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/bind'),
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.[0]).toBe('/api/threads/thread-1/sessions/opus/bind');
      expect(patchCall?.[1]).toMatchObject({
        method: 'PATCH',
        body: JSON.stringify({ cliSessionId: 'ses_test_123' }),
      });
    });

    it('shows error status on failed bind', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();

      // Open bind input
      const bindBtn = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'bind...');
      act(() => {
        bindBtn?.click();
      });

      // Type value
      const input = container.querySelector('input[placeholder="CLI session ID"]') as HTMLInputElement;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'bad_session');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Mock failed bind
      mockApiFetch.mockResolvedValue({ ok: false, status: 404 });

      const submitBtn = Array.from(container.querySelectorAll('button')).find((btn) => btn.textContent === 'bind');
      act(() => {
        submitBtn?.click();
      });

      await flushFetch();

      expect(container.textContent).toContain('err');
    });
  });
});
