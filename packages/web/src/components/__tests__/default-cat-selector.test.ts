/**
 * F154 Phase B / #543 — DefaultCatSelector: dropdown for choosing the global default cat.
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

describe('DefaultCatSelector (#543: dropdown)', () => {
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

  it('renders a <select> with options for all cats', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
        }),
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="default-cat-select"]');
    expect(select).not.toBeNull();
    expect(select!.options.length).toBe(3);
    expect(select!.value).toBe('opus');
  });

  it('shows current cat color dot', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
        }),
      );
    });
    const dot = container.querySelector<HTMLElement>('[data-testid="current-color-dot"]');
    expect(dot).not.toBeNull();
    expect(dot!.style.backgroundColor).toBe('rgb(255, 171, 145)'); // #FFAB91
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

  it('calls onSelect when changing dropdown value', () => {
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
    const select = container.querySelector<HTMLSelectElement>('[data-testid="default-cat-select"]');
    expect(select).not.toBeNull();
    act(() => {
      // Simulate selecting codex
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(select!, 'codex');
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('codex');
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
    // Should still render the select
    const select = container.querySelector('[data-testid="default-cat-select"]');
    expect(select).not.toBeNull();
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

  it('disables select when loading', () => {
    act(() => {
      root.render(
        React.createElement(DefaultCatSelector, {
          cats: TEST_CATS,
          currentDefaultCatId: 'opus',
          onSelect: vi.fn(),
          isLoading: true,
        }),
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="default-cat-select"]');
    expect(select!.disabled).toBe(true);
  });
});
