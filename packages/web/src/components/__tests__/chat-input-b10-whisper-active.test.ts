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
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['布偶', 'opus'],
        provider: 'anthropic',
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
        provider: 'openai',
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
  return [...container.querySelectorAll('button')].filter((b) => b.className.includes('rounded-full'));
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

    // opus (executing) should NOT be selected (no bg-amber-50)
    expect(opusChip?.className).toContain('cursor-not-allowed');
    expect(opusChip?.className).not.toContain('bg-amber-50');
    // codex (idle) should be auto-selected
    expect(codexChip?.className).toContain('bg-amber-50');
  });

  it('shows hourglass indicator on executing cat chip', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'codex', mode: 'execute', startedAt: Date.now() } },
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));
    enterWhisperMode();

    const chips = getWhisperChips();
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));
    expect(codexChip?.textContent).toContain('⏳');
  });

  it('all cats selectable when none are executing', () => {
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn() })));
    enterWhisperMode();

    const chips = getWhisperChips();
    for (const chip of chips) {
      expect(chip.disabled).toBe(false);
      expect(chip.className).toContain('bg-amber-50');
    }
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
