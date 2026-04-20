/**
 * F154 Phase B — ThreadCatPill: shows preferred cat in header, opens CatSelector popover.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

const TEST_CATS = [
  {
    id: 'opus',
    displayName: 'opus',
    nickname: '宪宪',
    variantLabel: undefined,
    breedDisplayName: '布偶猫',
    color: { primary: '#FFAB91', secondary: '#8D6E63' },
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    isDefaultVariant: true,
    source: 'seed' as const,
  },
  {
    id: 'codex',
    displayName: 'codex',
    nickname: '砚砚',
    variantLabel: undefined,
    breedDisplayName: '缅因猫',
    color: { primary: '#66BB6A', secondary: '#2E7D32' },
    clientId: 'openai',
    defaultModel: 'gpt-5.3-codex',
    isDefaultVariant: true,
    source: 'seed' as const,
  },
];

const mockCatData = {
  cats: TEST_CATS,
  isLoading: false,
  getCatById: (id: string) => TEST_CATS.find((c) => c.id === id),
  getCatsByBreed: () => new Map(),
  refresh: vi.fn(),
};
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => mockCatData,
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName} ${cat.variantLabel}` : cat.displayName,
}));

const TEST_THREAD = {
  id: 'thread_pill_test',
  title: 'Pill Test Thread',
  projectPath: '/projects/cat-cafe',
  createdBy: 'user1',
  participants: ['user1'],
  lastActiveAt: Date.now(),
  createdAt: Date.now(),
  pinned: false,
  favorited: false,
  preferredCats: ['opus'] as string[],
};

const mockStore: Record<string, unknown> = {
  threads: [TEST_THREAD],
  updateThreadPreferredCats: vi.fn(),
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

// Lazy import after mocks
const { ThreadCatPill } = await import('@/components/ThreadCatPill');

describe('ThreadCatPill (F154 Phase B)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mockStore.threads = [{ ...TEST_THREAD, preferredCats: ['opus'] }];
  });

  afterEach(() => {
    container.remove();
  });

  const renderPill = (threadId: string) => {
    container.innerHTML = renderToStaticMarkup(React.createElement(ThreadCatPill, { threadId }));
    return container;
  };

  it('renders pill with cat name when preferredCats is set', () => {
    expect(renderPill('thread_pill_test').textContent).toContain('opus');
  });

  it('renders ghost pill when preferredCats is empty', () => {
    mockStore.threads = [{ ...TEST_THREAD, preferredCats: [] }];
    const el = renderPill('thread_pill_test');
    expect(el.textContent).toContain('首选猫');
    expect(el.querySelector('[data-testid="pill-dot"]')).toBeNull();
  });

  it('renders ghost pill when preferredCats is undefined', () => {
    mockStore.threads = [{ ...TEST_THREAD, preferredCats: undefined }];
    const el = renderPill('thread_pill_test');
    expect(el.textContent).toContain('首选猫');
  });

  it('shows persona color dot matching the cat', () => {
    const dot = renderPill('thread_pill_test').querySelector('[data-testid="pill-dot"]');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('style')).toContain('background-color:#FFAB91');
  });

  it('renders ghost pill for unknown threadId', () => {
    const el = renderPill('thread_nonexistent');
    expect(el.textContent).toContain('首选猫');
  });

  it('shows chevron indicating expandable', () => {
    expect(renderPill('thread_pill_test').textContent).toContain('▾');
  });
});
