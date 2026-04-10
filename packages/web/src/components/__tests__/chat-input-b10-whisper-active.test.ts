/**
 * F122B AC-B10: Whisper mode disables actively-executing cats.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useChatStore } from '@/stores/chatStore';

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

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['布偶', 'opus'],
        clientId: 'anthropic',
        defaultModel: 'opus',
        avatar: '/a.png',
        roleDescription: 'dev',
        personality: 'kind',
      },
      {
        id: 'codex',
        displayName: '缅因猫',
        color: { primary: '#4CAF50', secondary: '#C8E6C9' },
        mentionPatterns: ['缅因', 'codex'],
        clientId: 'openai',
        defaultModel: 'codex',
        avatar: '/b.png',
        roleDescription: 'review',
        personality: 'steady',
      },
    ],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

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
  useChatStore.setState({ activeInvocations: {}, hasActiveInvocation: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function getWhisperChips() {
  // F108 Scene 2 v2: selector rows inside the floating popup (absolute bottom-full)
  const popup = container.querySelector('.absolute.bottom-full');
  if (!popup) return [];
  return [...popup.querySelectorAll('button')];
}

function enterWhisperMode() {
  const btn = container.querySelector<HTMLButtonElement>('[aria-label="Whisper mode"]');
  act(() => btn?.click());
}

describe('F122B AC-B10: whisper mode + executing cats', () => {
  it('disables executing cat chips in whisper selector', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    enterWhisperMode();

    const chips = getWhisperChips();
    const opusChip = chips.find((b) => b.textContent?.includes('布偶猫'));
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));

    expect(opusChip).toBeDefined();
    expect(codexChip).toBeDefined();
    expect(opusChip?.disabled).toBe(true);
    expect(codexChip?.disabled).toBe(false);
  });

  it('does not auto-select executing cats when entering whisper mode', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    enterWhisperMode();

    const chips = getWhisperChips();
    const opusChip = chips.find((b) => b.textContent?.includes('布偶猫'));
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));

    // opus (executing) should NOT be selected and is disabled
    expect(opusChip?.className).toContain('cursor-not-allowed');
    expect(opusChip?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');
    // codex (idle) should NOT be pre-selected either (F108B: default none)
    expect(codexChip?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');
  });

  it('shows "执行中" status badge on executing cat row', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() } },
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    enterWhisperMode();

    const chips = getWhisperChips();
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));
    expect(codexChip?.textContent).toContain('执行中');
  });

  it('all cats selectable but none pre-selected when none are executing', () => {
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn() })));
    enterWhisperMode();

    const chips = getWhisperChips();
    for (const chip of chips) {
      expect(chip.disabled).toBe(false);
      expect(chip.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated'); // F108B: default none selected
    }
  });

  it('F108B AC-B7: whisper to idle cat shows whisper placeholder, not queue placeholder', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
      hasActiveInvocation: true,
    });
    // Before whisper mode: should show queue placeholder (cat is active)
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    const textarea = container.querySelector('textarea')!;
    expect(textarea.placeholder).toContain('排队');

    // Enter whisper mode — default is no selection (F108B P1-1 fix)
    enterWhisperMode();

    // Manually select codex (idle) — simulates user clicking the chip
    const chips = getWhisperChips();
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));
    act(() => codexChip?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));

    // After selecting idle cat: should show whisper placeholder, not queue
    expect(textarea.placeholder).toBe('悄悄话...');
  });

  it('P1-1: entering whisper mode defaults to NO cats selected (design spec)', () => {
    // Design: F108-side-dispatch-phase-b-ux.pen Scene 1 says "默认都不选（✅）"
    // No active invocations — all cats should be selectable but NONE pre-selected.
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn() })));
    enterWhisperMode();

    const chips = getWhisperChips();
    for (const chip of chips) {
      expect(chip.disabled).toBe(false); // All selectable
      expect(chip.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated'); // None pre-selected
    }
  });

  it('P1-1: entering whisper with active cat — idle cats NOT pre-selected either', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    enterWhisperMode();

    const chips = getWhisperChips();
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));
    // codex is idle but should NOT be auto-selected
    expect(codexChip?.disabled).toBe(false);
    expect(codexChip?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');
  });

  it('falls back to targetCats when activeInvocations is empty but hasActiveInvocation is true (legacy path)', () => {
    useChatStore.setState({
      activeInvocations: {},
      hasActiveInvocation: true,
      targetCats: ['opus'],
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    enterWhisperMode();

    const chips = getWhisperChips();
    const opusChip = chips.find((b) => b.textContent?.includes('布偶猫'));
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));

    expect(opusChip?.disabled).toBe(true);
    expect(codexChip?.disabled).toBe(false);
  });
});
