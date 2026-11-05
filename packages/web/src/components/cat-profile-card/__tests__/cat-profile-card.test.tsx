import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ConversationViewPreferenceController } from '@/hooks/useConversationViewPreference';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { CatNameplate } from '../../CatNameplate';
import { writeShellLanguage } from '../../shell/shell-language';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../../shell/shell-presentation';
import { useCatCardComposer } from '../CatProfileCardContext';
import { CatProfileCardScope } from '../CatProfileCardScope';

const { push, cats } = vi.hoisted(() => ({
  push: vi.fn(),
  cats: [
    {
      id: 'deepseek-flash',
      nickname: '鲸鲸',
      displayName: '俄罗斯蓝猫',
      breedDisplayName: '俄罗斯蓝猫',
      breedId: 'russian-blue',
      mentionPatterns: ['@deepseek-flash'],
      avatar: '/avatars/jingjing.png',
      color: { primary: '#4B6E8A', secondary: '#E4EDF3' },
      carrier: 'cli',
      clientId: 'deepseek',
      defaultModel: 'DeepSeek V4.1 Flash-1017',
      personality: '安静、低声，但传得远。',
      roleDescription: '',
    },
  ] as CatData[],
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats, getCatById: (id: string) => cats.find((c) => c.id === id) }),
}));
vi.mock('../../routing-context/useRoutingContext', () => ({
  useRoutingContext: () => ({ data: null, loading: false, error: 'offline' }),
}));

let root: Root, container: HTMLDivElement;
const save = vi.fn();
const controller = {
  save,
  loading: false,
  saving: false,
  error: null,
  snapshot: { stored: null, effective: { mode: 'group' }, source: 'product' },
  subscribeBeforeCommit: () => () => {},
} satisfies ConversationViewPreferenceController;

function Composer() {
  const [input, setInput] = useState('前半段 后半段');
  const ref = useRef<HTMLTextAreaElement>(null);
  useCatCardComposer(input, setInput, ref);
  return <textarea ref={ref} aria-label="草稿" value={input} onChange={(event) => setInput(event.target.value)} />;
}
function renderScope(threadId: string, enabled = true) {
  root.render(
    <CatProfileCardScope threadId={threadId} conversationView={controller} enabled={enabled}>
      <CatNameplate catId="deepseek-flash" name="鲸鲸" onEditCat={() => push('/old-settings')} />
      <Composer key={threadId} />
    </CatProfileCardScope>,
  );
}
beforeEach(() => {
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    currentThreadId: 'card-thread',
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    threadStates: {},
  });
  push.mockClear();
  save.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => renderScope('card-thread'));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected the rendered element');
  return value;
}
const card = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="看猫 · 鲸鲸"]');
const button = (text: string) =>
  required(Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === text));
const open = () =>
  act(() => {
    const trigger = required(container.querySelector<HTMLButtonElement>('[data-testid="cat-nameplate-name"]'));
    trigger.focus();
    trigger.click();
  });

it('keeps hover passive, opens by name, and dismisses outside or with Escape', () => {
  act(() =>
    required(container.querySelector('[data-testid="cat-nameplate-name"]')).dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    ),
  );
  expect(card()).toBeNull();
  open();
  expect(card()?.textContent).toContain('「安静、低声，但传得远。」');
  expect(push).not.toHaveBeenCalled();
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(card()).toBeNull();
  open();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(card()).toBeNull();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('cat-nameplate-name');
});

it('closes on thread changes without resurrecting the old selection on return', () => {
  open();
  expect(card()).not.toBeNull();
  act(() => renderScope('other-thread'));
  expect(card()).toBeNull();
  act(() => renderScope('card-thread'));
  expect(card()).toBeNull();
  open();
  act(() => button('@ 它').click());
  expect(container.querySelector('textarea')?.value).toContain('@deepseek-flash');
});

it('disables card behavior without remounting the composer or reviving the selection when re-enabled', () => {
  const composer = required(container.querySelector('textarea'));
  open();
  expect(card()).not.toBeNull();
  act(() => renderScope('card-thread', false));
  expect(card()).toBeNull();
  expect(container.querySelector('textarea')).toBe(composer);
  expect(composer.value).toBe('前半段 后半段');
  open();
  expect(push).toHaveBeenCalledExactlyOnceWith('/old-settings');
  expect(card()).toBeNull();
  act(() => renderScope('card-thread'));
  expect(container.querySelector('textarea')).toBe(composer);
  expect(card()).toBeNull();
  open();
  act(() => button('@ 它').click());
  expect(composer.value).toContain('@deepseek-flash');
});

it('opens the original with the existing Lightbox and returns to the same card', () => {
  open();
  act(() => required(card()?.querySelector<HTMLButtonElement>('[aria-label="查看鲸鲸的原图"]')).click());
  const original = document.querySelector('[role="dialog"][aria-label="鲸鲸的原图"]');
  expect(original?.querySelector('img')?.getAttribute('src')).toBe('/avatars/jingjing.png');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[aria-label="鲸鲸的原图"]')).toBeNull();
  expect(card()).not.toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(card()).toBeNull();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('cat-nameplate-name');
});

it('inserts the registered mention at the blurred selection and preserves both sides of the draft', () => {
  const input = required(container.querySelector('textarea'));
  input.focus();
  input.setSelectionRange(4, 4);
  open();
  act(() => button('@ 它').click());
  expect(input.value).toBe('前半段 @deepseek-flash 后半段');
  expect(input.selectionStart).toBe('前半段 @deepseek-flash '.length);
  expect(document.activeElement).toBe(input);
  expect(card()).toBeNull();
});

it('retains the card on a failed view save, then delegates a successful cat view to the existing owner', async () => {
  save.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  open();
  await act(async () => button('只看它的回话').click());
  expect(card()?.querySelector('[role="alert"]')?.textContent).toContain('未能切换');
  await act(async () => button('只看它的回话').click());
  expect(save).toHaveBeenLastCalledWith({ mode: 'cat', catId: 'deepseek-flash' });
  expect(card()).toBeNull();
});

it('keeps the settings navigation on the explicit settings action', () => {
  open();
  act(() => button('设置 ›').click());
  expect(push).toHaveBeenCalledExactlyOnceWith('/settings?s=members&shell=v2&cat=deepseek-flash');
});

it('uses the member page’s translated status in the same open English card', () => {
  open();
  expect(card()?.textContent).toContain('未确认');
  act(() => writeShellLanguage('en'));
  expect(document.querySelector('[role="dialog"][aria-label="Meet 鲸鲸"]')?.textContent).toContain('Unconfirmed');
  act(() => writeShellLanguage('zh'));
});

it.each([
  { model: 'claude-opus-5-5', label: undefined, expected: 'Claude Opus 5.5' },
  {
    model: '["deepseek-official","deepseek-flash"]',
    label: 'DeepSeek V4.1 Flash-1017',
    expected: 'DeepSeek V4.1 Flash-1017',
  },
  { model: 'private-model-v1', label: undefined, expected: 'private-model-v1' },
])('shows the shared model name in Chinese and English: $expected', ({ model, label, expected }) => {
  const previous = { defaultModel: cats[0].defaultModel, variantLabel: cats[0].variantLabel };
  try {
    Object.assign(cats[0], { defaultModel: model, variantLabel: label });
    open();
    expect(card()?.textContent).toContain(`模型 ${expected}`);
    act(() => writeShellLanguage('en'));
    expect(document.querySelector('[role="dialog"][aria-label="Meet 鲸鲸"]')?.textContent).toContain(
      `Model ${expected}`,
    );
  } finally {
    Object.assign(cats[0], previous);
  }
});

it('reads the execution row’s current thread/cat identity and removes a completed or stale reply claim', () => {
  const execution: ActiveExecutionProjection = {
    executionId: 'run-one',
    turnInvocationId: 'turn-one',
    catId: 'deepseek-flash',
    threadId: 'card-thread',
    threadTitle: '卡片测试',
    kind: 'live_invocation' as const,
    startedAt: Date.now() - 21_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: 'card-thread', catId: 'deepseek-flash', executionId: 'run-one' },
    },
  };
  act(() =>
    useActiveExecutionStore.setState({
      anchorThreadId: 'card-thread',
      hydration: 'ready',
      executionsByKey: { [activeExecutionKey(execution)]: execution },
    }),
  );
  open();
  expect(card()?.textContent).toContain('正在这条对话里回复 · 0:21');
  act(() => useActiveExecutionStore.setState({ hydration: 'error' }));
  expect(card()?.textContent).toContain('回复状态未确认');
  expect(card()?.textContent).not.toContain('正在这条对话里回复');
  act(() => useActiveExecutionStore.setState({ hydration: 'ready', executionsByKey: {} }));
  expect(card()?.textContent).toContain('未确认');
  expect(card()?.textContent).not.toContain('看它在干什么');
});

it('marks an unsettled legacy reply only for the cat in this thread and clears it once canonical truth settles', () => {
  act(() =>
    useChatStore.setState({
      hasActiveInvocation: true,
      activeInvocations: { 'legacy-one': { catId: 'deepseek-flash', mode: 'execute' } },
    }),
  );
  open();
  expect(card()?.textContent).toContain('回复状态未确认');
  act(() => useChatStore.setState({ activeInvocations: { 'legacy-other': { catId: 'opus55', mode: 'execute' } } }));
  expect(card()?.textContent).not.toContain('回复状态未确认');
  act(() =>
    useChatStore.setState({
      currentThreadId: 'other-thread',
      activeInvocations: { 'legacy-one': { catId: 'deepseek-flash', mode: 'execute' } },
    }),
  );
  expect(card()?.textContent).not.toContain('回复状态未确认');
  act(() => useChatStore.setState({ currentThreadId: 'card-thread' }));
  expect(card()?.textContent).toContain('回复状态未确认');
  act(() => useActiveExecutionStore.setState({ anchorThreadId: 'card-thread', hydration: 'ready' }));
  expect(card()?.textContent).not.toContain('回复状态未确认');
});
