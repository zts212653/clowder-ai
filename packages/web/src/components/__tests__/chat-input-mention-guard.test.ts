/**
 * F32-b Phase 3: Regression test for mention menu selectedIdx OOB guard.
 *
 * Guards against a race condition: catOptions can shrink (e.g. API fetch
 * returns fewer cats than fallback) while the mention menu is open and
 * selectedIdx points to a now-invalid position. The sync guard at the
 * Enter/Tab insertion point prevents `insertMention(undefined)` crash.
 *
 * Since `act()` flushes React effects (making the async clamp fire before
 * keydown), we test the two defensive layers independently:
 * 1. Empty catOptions: typing "@" then Enter → no crash, menu closes
 * 2. Happy path: typing "@" then Enter with valid cats → mention inserted
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

// Controllable useCatData mock — swap cats mid-test via mockCats
const mockCats = { current: buildCatsWithPatterns() };

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: mockCats.current,
    isLoading: false,
    getCatById: (id: string) => mockCats.current.find((c: { id: string }) => c.id === id),
    getCatsByBreed: () => new Map(),
  }),
}));

function buildCatsWithPatterns() {
  return [
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
      id: 'codex',
      displayName: '缅因猫',
      color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
      mentionPatterns: ['缅因', '缅因猫', 'codex'],
      clientId: 'openai',
      defaultModel: 'codex',
      avatar: '/b.png',
      roleDescription: 'review',
      personality: 'strict',
    },
  ];
}

function buildCatsNoPatterns() {
  return [
    {
      id: 'opus',
      displayName: '布偶猫',
      color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
      mentionPatterns: [] as string[],
      clientId: 'anthropic',
      defaultModel: 'opus',
      avatar: '/a.png',
      roleDescription: 'dev',
      personality: 'kind',
    },
  ];
}

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
  mockCats.current = buildCatsWithPatterns();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const defaults = { onSend: vi.fn(), disabled: false };
  act(() => {
    root.render(React.createElement(ChatInput, { ...defaults, ...props }));
  });
  return defaults;
}

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea')!;
}

function typeInTextarea(value: string) {
  const ta = getTextarea();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function pressKey(key: string) {
  const ta = getTextarea();
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ChatInput mention menu guards', () => {
  it('Enter on mention menu with empty catOptions does not crash and closes menu', () => {
    // All cats have empty mentionPatterns → buildCatOptions filters all out → catOptions = []
    mockCats.current = buildCatsNoPatterns();
    render();

    // Type "@" to trigger mention menu
    typeInTextarea('@');

    // Press Enter — should not crash (guard: activeOptions.length === 0)
    pressKey('Enter');

    // Menu should be closed (no .w-64 mention menu div)
    expect(container.querySelectorAll('.w-64').length).toBe(0);
  });

  it('Enter on mention menu with valid catOptions inserts mention', () => {
    render();

    // Type "@" to open mention menu
    typeInTextarea('@');

    // Mention menu should be visible
    expect(container.querySelectorAll('.w-64').length).toBe(1);

    // Press Enter to select first cat (selectedIdx defaults to 0)
    pressKey('Enter');

    // Menu should close
    expect(container.querySelectorAll('.w-64').length).toBe(0);

    // Input should contain the inserted mention
    const ta = getTextarea();
    expect(ta.value).toContain('布偶');
  });

  it('ArrowDown past last item wraps to 0 and Enter still works', () => {
    // 2 cats: index 0 and 1
    render();

    typeInTextarea('@');
    expect(container.querySelectorAll('.w-64').length).toBe(1);

    // ArrowDown 3 times: 0→1→0→1 (mod 2 wrapping)
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('ArrowDown');

    // Enter should insert the cat at wrapped index (1) — 缅因猫
    pressKey('Enter');

    const ta = getTextarea();
    expect(ta.value).toContain('缅因');
  });
});
