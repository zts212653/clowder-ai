/**
 * F32-b Phase 3: Regression test for whisper target selection.
 *
 * Verifies that cats with empty mentionPatterns still appear in the
 * whisper target list and can be toggled. This prevents re-coupling
 * whisper targets to the mention-filtered catOptions in future refactors.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';

// ── Mocks ──
vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (f: File) => Promise.resolve(f) }));

// Two cats: one with mentionPatterns, one without (non-default variant)
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['布偶', '布偶猫', 'opus'],
        clientId: 'anthropic',
        defaultModel: 'opus',
        avatar: '/a.png',
        roleDescription: 'dev',
        personality: 'kind',
      },
      {
        id: 'opus-fast',
        displayName: '布偶猫(快)',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: [],
        clientId: 'anthropic',
        defaultModel: 'opus-fast',
        avatar: '/a.png',
        roleDescription: '快速变体',
        personality: 'kind',
      },
    ],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

// ── Setup ──
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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

describe('ChatInput whisper targets with empty mentionPatterns', () => {
  it('shows all cats including those with empty mentionPatterns as whisper targets', () => {
    act(() => {
      root.render(React.createElement(ChatInput, { onSend: vi.fn() }));
    });

    // Click the whisper mode toggle (aria-label="Whisper mode")
    const whisperBtn = container.querySelector<HTMLButtonElement>('[aria-label="Whisper mode"]');
    expect(whisperBtn).not.toBeNull();
    act(() => whisperBtn?.click());

    // F108 Scene 2 v2: floating popup with "悄悄话目标 · 可多选"
    expect(container.textContent).toContain('悄悄话目标');

    // Both cats should appear as rows inside the floating popup (absolute bottom-full)
    const popup = container.querySelector('.absolute.bottom-full');
    expect(popup).not.toBeNull();
    const selectorRows = [...popup!.querySelectorAll('button')];
    const rowTexts = selectorRows.map((b) => b.textContent);

    expect(rowTexts.some((t) => t?.includes('布偶猫'))).toBe(true);
    expect(rowTexts.some((t) => t?.includes('布偶猫(快)'))).toBe(true);
  });

  it('can toggle a whisper target with empty mentionPatterns', () => {
    act(() => {
      root.render(React.createElement(ChatInput, { onSend: vi.fn() }));
    });

    // Enter whisper mode
    const whisperBtn = container.querySelector<HTMLButtonElement>('[aria-label="Whisper mode"]');
    act(() => whisperBtn?.click());

    // Find the opus-fast row in the floating popup
    const popup = container.querySelector('.absolute.bottom-full')!;
    const getRows = () => [...popup.querySelectorAll('button')];
    let fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn).toBeDefined();

    // F108B P1-1: default is NO cats selected — no elevated background
    expect(fastBtn?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');

    // mousedown to select — should show elevated background
    act(() => fastBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn?.className.split(/\s+/)).toContain('bg-cafe-surface-elevated');

    // mousedown to deselect
    act(() => fastBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');

    // mousedown again to re-select
    act(() => fastBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn?.className.split(/\s+/)).toContain('bg-cafe-surface-elevated');
  });
});
