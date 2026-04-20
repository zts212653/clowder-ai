/**
 * F154 Phase B — DefaultCatSelector: card grid for choosing the global default cat.
 * AC-B2: Member overview has global default cat selector.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    mentionPatterns: ['opus'],
    avatar: '',
    roleDescription: '',
    personality: '',
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
    mentionPatterns: ['codex'],
    avatar: '',
    roleDescription: '',
    personality: '',
  },
  {
    id: 'gemini',
    displayName: 'gemini',
    nickname: '烁烁',
    variantLabel: undefined,
    breedDisplayName: '暹罗猫',
    color: { primary: '#81D4FA', secondary: '#0277BD' },
    clientId: 'google',
    defaultModel: 'gemini-2.5-pro',
    isDefaultVariant: true,
    source: 'seed' as const,
    mentionPatterns: ['gemini'],
    avatar: '',
    roleDescription: '',
    personality: '',
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

// Lazy import after mocks
const { DefaultCatSelector } = await import('@/components/DefaultCatSelector');

describe('DefaultCatSelector (F154 Phase B, AC-B2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders cat cards for all available cats', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
        }),
      );
    });
    // Each cat should have a card
    expect(container.textContent).toContain('opus');
    expect(container.textContent).toContain('codex');
    expect(container.textContent).toContain('gemini');
  });

  it('highlights the current default cat with "默认" badge', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
        }),
      );
    });
    expect(container.textContent).toContain('默认');
    // Only one badge
    const badges = container.querySelectorAll('[data-testid="default-badge"]');
    expect(badges.length).toBe(1);
  });

  it('shows scope description', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
        }),
      );
    });
    expect(container.textContent).toContain('新 thread');
  });

  it('calls onSelect when clicking a non-default cat card', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect,
        }),
      );
    });
    // Click the codex card
    const cards = container.querySelectorAll('[data-testid="default-cat-card"]');
    const codexCard = [...cards].find((c) => c.textContent?.includes('codex'));
    expect(codexCard).not.toBeNull();
    act(() => {
      codexCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

  it('shows persona color for each cat card', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
        }),
      );
    });
    const dots = container.querySelectorAll('[data-testid="card-color-dot"]');
    expect(dots.length).toBe(3);
  });

  it('shows error hint and retry button when fetchError is true (P1-2)', () => {
    const onRetry = vi.fn();
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: '',
          onSelect: vi.fn(),
          fetchError: true,
          onRetry,
        }),
      );
    });
    // Should still render the card grid (AC-B2: selector must be visible)
    const cards = container.querySelectorAll('[data-testid="default-cat-card"]');
    expect(cards.length).toBe(3);
    // Should show error hint
    expect(container.textContent).toContain('加载失败');
    // Should have retry button
    const retryBtn = container.querySelector('[data-testid="retry-fetch"]');
    expect(retryBtn).not.toBeNull();
    act(() => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows error message when saveError is provided (P2-1)', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
          saveError: '保存失败，请重试',
        }),
      );
    });
    expect(container.textContent).toContain('保存失败');
  });
});
