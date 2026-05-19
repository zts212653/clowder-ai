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
import { __resetSessionChainCacheForTest, SessionChainPanel } from '../SessionChainPanel';

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

// useCatData stub — mirrors cat-config.json so SessionChainPanel can pull
// border/badge colors from cat.color.primary instead of a hardcoded table.
const MOCK_CATS: Record<string, { id: string; displayName: string; color: { primary: string; secondary: string } }> = {
  opus: { id: 'opus', displayName: '布偶猫', color: { primary: '#9B7EBD', secondary: '#E8DFF5' } },
  codex: { id: 'codex', displayName: '缅因猫', color: { primary: '#5B8C5A', secondary: '#D4E6D3' } },
  gemini: { id: 'gemini', displayName: '暹罗猫', color: { primary: '#4A90E2', secondary: '#D8E6F8' } },
  kimi: { id: 'kimi', displayName: '梵花猫', color: { primary: '#4B5563', secondary: '#E5E7EB' } },
  dare: { id: 'dare', displayName: '狸花猫', color: { primary: '#FFB300', secondary: '#FFE082' } },
  gpt52: { id: 'gpt52', displayName: '缅因猫', color: { primary: '#66BB6A', secondary: '#C8E6C9' } },
  'opus-45': { id: 'opus-45', displayName: '布偶猫', color: { primary: '#7E57C2', secondary: '#E1D5F0' } },
  'opus-47': { id: 'opus-47', displayName: '布偶猫', color: { primary: '#7B1FA2', secondary: '#E1BEE7' } },
  sonnet: { id: 'sonnet', displayName: '布偶猫', color: { primary: '#B39DDB', secondary: '#EDE7F6' } },
};

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: Object.values(MOCK_CATS),
    isLoading: false,
    getCatById: (id: string) => MOCK_CATS[id],
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
  __resetSessionChainCacheForTest();
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
    expect(container.textContent).toContain('opus');
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

  it('renders kimi colors from cat.color (border inline style)', async () => {
    // kimi primary #4B5563 → 75,85,99
    mockSessionsResponse([
      { id: 'kimi_s1', catId: 'kimi', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="kimi"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.borderColor).toMatch(/rgba?\(75,\s*85,\s*99/);
  });

  it('renders catId in the active session badge (not breed displayName)', async () => {
    mockSessionsResponse([
      { id: 's1', catId: 'kimi', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('kimi');
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

  it('keeps stale data visible on thread switch when fetch fails (stale-while-revalidate)', async () => {
    // First thread loads successfully
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('Session #1');

    // Switch to thread-2, but fetch fails — stale data stays visible
    mockApiFetch.mockResolvedValue({ ok: false, status: 500 });
    renderPanel('thread-2');
    await flushFetch();

    // Stale-while-revalidate: old data remains visible on transient error
    expect(container.textContent).toContain('Session #1');
  });

  it('keeps stale data visible on thread switch when fetch throws (stale-while-revalidate)', async () => {
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

    // Switch to thread-B, but fetch throws — stale data stays visible
    mockApiFetch.mockRejectedValue(new Error('network error'));
    renderPanel('thread-B');
    await flushFetch();

    // Stale-while-revalidate: old data remains visible on transient error
    expect(container.textContent).toContain('Session #1');
  });

  it('disables unseal button on stale data during AND after failed refetch (stale barrier)', async () => {
    // Load sealed session for thread-1
    mockSessionsResponse([
      {
        id: 's1',
        catId: 'opus',
        seq: 0,
        status: 'sealed',
        messageCount: 5,
        createdAt: Date.now() - 60000,
        sealedAt: Date.now(),
      },
    ]);
    renderPanel('thread-1');
    await flushFetch();

    const findUnsealBtn = () => {
      const buttons = Array.from(container.querySelectorAll('button'));
      return buttons.find((b) => b.textContent?.includes('解封')) as HTMLButtonElement | undefined;
    };

    // Unseal button should be enabled for fresh data
    expect(findUnsealBtn()!.disabled).toBe(false);

    // Switch to thread-2, fetch fails — stale data from thread-1 stays visible
    mockApiFetch.mockRejectedValue(new Error('network error'));
    renderPanel('thread-2');
    await flushFetch();

    // Unseal button must stay DISABLED even after loading finishes,
    // because data belongs to thread-1 not thread-2 (entity mismatch)
    const staleBtn = findUnsealBtn();
    expect(staleBtn).toBeDefined();
    expect(staleBtn!.disabled).toBe(true);

    // Also verify stale indicator is shown
    expect(container.textContent).toContain('Refreshing...');
  });

  it('replaces stale data when new thread fetch succeeds (stale-while-revalidate)', async () => {
    // First thread loads
    mockSessionsResponse([
      { id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('Session #1');

    // Switch to thread-2 with different data — old data replaced
    mockSessionsResponse([
      { id: 's2', catId: 'codex', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
    ]);
    renderPanel('thread-2');
    await flushFetch();

    // New data visible, old data gone
    expect(container.textContent).toContain('codex');
    expect(container.textContent).toContain('1 session');
  });

  it('reuses per-thread session cache immediately when revisiting a thread during revalidate', async () => {
    let resolveThread1Revisit!: (value: unknown) => void;
    const thread1Revisit = new Promise((resolve) => {
      resolveThread1Revisit = resolve;
    });

    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [{ id: 's1', catId: 'opus', seq: 0, status: 'active', messageCount: 5, createdAt: Date.now() }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [{ id: 's2', catId: 'codex', seq: 5, status: 'active', messageCount: 3, createdAt: Date.now() }],
        }),
      })
      .mockImplementationOnce(() => thread1Revisit);

    renderPanel('thread-1');
    await flushFetch();
    expect(container.textContent).toContain('Session #1');

    renderPanel('thread-2');
    await flushFetch();
    expect(container.textContent).toContain('Session #6');
    expect(container.textContent).toContain('codex');

    renderPanel('thread-1');
    await flushFetch();

    // Cache should win immediately while revalidate is still in flight.
    expect(container.textContent).toContain('Session #1');
    expect(container.textContent).not.toContain('Session #6');

    resolveThread1Revisit({
      ok: true,
      json: async () => ({
        sessions: [{ id: 's1b', catId: 'opus', seq: 1, status: 'active', messageCount: 6, createdAt: Date.now() }],
      }),
    });
    await flushFetch();

    expect(container.textContent).toContain('Session #2');
    expect(container.textContent).not.toContain('Session #6');
  });

  it('applies codex green colors from cat.color (border + badge inline style)', async () => {
    // codex primary #5B8C5A → 91,140,90; secondary #D4E6D3 → 212,230,211
    mockSessionsResponse([
      { id: 's1', catId: 'codex', seq: 0, status: 'active', messageCount: 3, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="codex"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.borderColor).toMatch(/rgba?\(91,\s*140,\s*90/);
    const badge = container.querySelector(
      '[data-testid="session-badge-active"][data-cat-id="codex"]',
    ) as HTMLElement | null;
    expect(badge?.textContent).toContain('codex');
    expect(badge!.style.backgroundColor).toMatch(/rgba?\(212,\s*230,\s*211/);
    expect(badge!.style.color).toMatch(/rgba?\(91,\s*140,\s*90/);
  });

  it('applies gemini colors from cat.color', async () => {
    // gemini primary #4A90E2 → 74,144,226
    mockSessionsResponse([
      { id: 's1', catId: 'gemini', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="gemini"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.borderColor).toMatch(/rgba?\(74,\s*144,\s*226/);
  });

  it('applies dare colors from cat.color', async () => {
    // dare primary #FFB300 → 255,179,0
    mockSessionsResponse([
      { id: 's1', catId: 'dare', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="dare"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.borderColor).toMatch(/rgba?\(255,\s*179,\s*0/);
  });

  it('applies gpt52 (maine-coon variant) colors from cat.color', async () => {
    // gpt52 primary #66BB6A → 102,187,106
    mockSessionsResponse([
      { id: 's1', catId: 'gpt52', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const card = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="gpt52"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.style.borderColor).toMatch(/rgba?\(102,\s*187,\s*106/);
  });

  it('applies opus-45 and sonnet (ragdoll variant) distinct colors from cat.color', async () => {
    // opus-45 primary #7E57C2 → 126,87,194; sonnet primary #B39DDB → 179,157,219
    mockSessionsResponse([
      { id: 's1', catId: 'opus-45', seq: 0, status: 'active', messageCount: 2, createdAt: Date.now() },
      { id: 's2', catId: 'sonnet', seq: 1, status: 'active', messageCount: 2, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const opus45 = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="opus-45"]',
    ) as HTMLElement | null;
    const sonnet = container.querySelector(
      '[data-testid="session-card-active"][data-cat-id="sonnet"]',
    ) as HTMLElement | null;
    expect(opus45).not.toBeNull();
    expect(sonnet).not.toBeNull();
    expect(opus45!.style.borderColor).toMatch(/rgba?\(126,\s*87,\s*194/);
    expect(sonnet!.style.borderColor).toMatch(/rgba?\(179,\s*157,\s*219/);
  });

  it('falls back to neutral gray when cat is missing from cat-config (badge background)', async () => {
    // Fallback: primary #9CA3AF → 156,163,175; secondary #E5E7EB → 229,231,235
    mockSessionsResponse([
      { id: 's1', catId: 'unknown-cat', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
    ]);
    renderPanel('thread-1');
    await flushFetch();
    const badge = container.querySelector(
      '[data-testid="session-badge-active"][data-cat-id="unknown-cat"]',
    ) as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('unknown-cat');
    expect(badge!.style.backgroundColor).toMatch(/rgba?\(229,\s*231,\s*235/);
    expect(badge!.style.color).toMatch(/rgba?\(156,\s*163,\s*175/);
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

  describe('cat color rendering — driven by cat-config.json (no hardcoded table)', () => {
    // Helper: extract numeric RGB triple from any inline color value.
    function rgbTripleOf(value: string): [number, number, number] | null {
      // Accepts "rgb(r, g, b)", "rgba(r, g, b, a)" — jsdom always serialises as rgb/rgba.
      const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    }

    it('opus-47 active session uses cat.color.primary (#7B1FA2 → 123,31,162) for border, not gray fallback', async () => {
      // opus-47 was missing from the legacy hardcoded CAT_SESSION_COLORS table,
      // so before the fix it fell through to the gray DEFAULT_SESSION_COLORS.
      mockSessionsResponse([
        { id: 's_47', catId: 'opus-47', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      const card = container.querySelector(
        '[data-testid="session-card-active"][data-cat-id="opus-47"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      const triple = rgbTripleOf(card!.style.borderColor);
      expect(triple).toEqual([123, 31, 162]);
    });

    it('opus-47 active session badge uses cat.color.secondary as background and primary as text', async () => {
      mockSessionsResponse([
        { id: 's_47', catId: 'opus-47', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      const badge = container.querySelector(
        '[data-testid="session-badge-active"][data-cat-id="opus-47"]',
      ) as HTMLElement | null;
      expect(badge).not.toBeNull();
      // Secondary #E1BEE7 → 225,190,231
      expect(rgbTripleOf(badge!.style.backgroundColor)).toEqual([225, 190, 231]);
      // Primary #7B1FA2 → 123,31,162
      expect(rgbTripleOf(badge!.style.color)).toEqual([123, 31, 162]);
    });

    it('sealed session for opus-47 also uses cat.color (parity with active card)', async () => {
      mockSessionsResponse([
        {
          id: 'seal_47',
          catId: 'opus-47',
          seq: 0,
          status: 'sealed',
          messageCount: 5,
          createdAt: Date.now() - 60000,
          sealedAt: Date.now(),
        },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      const card = container.querySelector(
        '[data-testid="session-card-sealed"][data-cat-id="opus-47"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(rgbTripleOf(card!.style.borderColor)).toEqual([123, 31, 162]);
    });

    it('falls back to neutral gray (#9CA3AF → 156,163,175) for unknown catId', async () => {
      mockSessionsResponse([
        { id: 's_x', catId: 'unknown-cat', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      const card = container.querySelector(
        '[data-testid="session-card-active"][data-cat-id="unknown-cat"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(rgbTripleOf(card!.style.borderColor)).toEqual([156, 163, 175]);
    });

    it('does not emit any of the legacy hardcoded color tokens', async () => {
      mockSessionsResponse([
        { id: 's1', catId: 'codex', seq: 0, status: 'active', messageCount: 1, createdAt: Date.now() },
        { id: 's2', catId: 'gemini', seq: 1, status: 'active', messageCount: 1, createdAt: Date.now() },
        { id: 's3', catId: 'opus-45', seq: 2, status: 'active', messageCount: 1, createdAt: Date.now() },
        { id: 's4', catId: 'gpt52', seq: 3, status: 'active', messageCount: 1, createdAt: Date.now() },
      ]);
      renderPanel('thread-1');
      await flushFetch();
      const html = container.innerHTML;
      // Legacy semantic tokens
      expect(html).not.toContain('border-codex-primary');
      expect(html).not.toContain('bg-codex-light');
      expect(html).not.toContain('text-codex-dark');
      expect(html).not.toContain('border-gemini-primary');
      expect(html).not.toContain('border-dare-primary');
      expect(html).not.toContain('border-kimi-primary');
      expect(html).not.toContain('border-opus-primary');
      // Legacy arbitrary hex tokens for gpt52 / opus-45 / sonnet
      expect(html).not.toContain('border-[#66BB6A66]');
      expect(html).not.toContain('border-[#7E57C266]');
      expect(html).not.toContain('border-[#B39DDB66]');
      // Legacy gray fallback class
      expect(html).not.toContain('border-cafe/40');
      expect(html).not.toContain('bg-gray-200');
    });
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

      // Should show codex (no active session) but not opus (has active session).
      // Asserting on option value (catId) instead of displayName so that other
      // ragdoll-family variants (sonnet/opus-45/opus-47) don't accidentally match.
      const select = container.querySelector('select');
      expect(select).not.toBeNull();
      const optionValues = Array.from(select!.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
      expect(optionValues).toContain('codex');
      expect(optionValues).not.toContain('opus');
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
