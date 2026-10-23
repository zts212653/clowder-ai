import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';
import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { AppendedInputReceipts } from '../AppendedInputReceipts';
import { ChatInputAddMenu } from '../ChatInputAddMenu';
import { ReplyPill } from '../ReplyPill';

let presentation: 'classic' | 'v2' = 'classic';
let overflowing = true;
vi.mock('../shell/shell-presentation', () => ({ useShellPresentation: () => presentation }));
vi.mock('../shell/shell-copy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell/shell-copy')>()),
  useShellCopy: (copy: { zh: unknown }) => copy.zh,
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'lang', color: { primary: '#6C5543' } }),
}));
vi.mock('@/utils/focusLineageMessage', () => ({ focusLineageMessage: vi.fn() }));
vi.mock('../content-overflow/useMeasuredOverflow', () => ({
  useMeasuredOverflow: () => ({ ref: vi.fn(), overflowing }),
}));
vi.mock('../AppTooltip', () => ({ AppTooltip: ({ children }: { children: React.ReactNode }) => children }));

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected rendered control');
  return value;
}
const getCatById = (id: string) =>
  ({ id, displayName: id, color: { primary: id === 'opus' ? '#8B5CF6' : '#22C55E' } }) as CatData;
const preference: MessageDispositionPreferenceController = {
  snapshot: { productDefault: 'next_work', thread: null, global: null, effective: 'next_work', source: 'product' },
  effective: 'next_work',
  source: 'product',
  loading: false,
  error: null,
  oneShot: null,
  setOneShot: vi.fn(),
  clearOneShot: vi.fn(),
  setPreference: vi.fn(async () => true),
};

describe('classic A2A presentation parity', () => {
  let container: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let root: Root;
  beforeEach(() => {
    presentation = 'classic';
    overflowing = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => ({ top: 640, left: 16 }) as DOMRect;
    document.body.append(container, trigger);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    trigger.remove();
  });
  const menu = () => (
    <ChatInputAddMenu
      hasActiveInvocation
      presentation={presentation}
      triggerRef={{ current: trigger }}
      messageDisposition={preference}
      onClose={vi.fn()}
      onAddContext={vi.fn()}
      onAttach={vi.fn()}
      onWhisperToggle={vi.fn()}
    />
  );

  it('restores the classic menu order and a paper surface independent of v2 tokens', () => {
    act(() => root.render(menu()));
    const ids = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.getAttribute('data-testid'));
    expect(ids).toEqual(['composer-add-context', 'composer-upload', 'message-disposition-trigger', 'composer-whisper']);
    const panel = required(document.querySelector('[role="dialog"]'));
    expect(panel.className).toContain('bg-cafe-surface-canvas');
    expect(panel.className).not.toContain('--shell-paper');
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toBe(
      '这条发出去后作为下一件工作',
    );
  });

  it('retains the v2 menu structure and palette while repairing classic', () => {
    presentation = 'v2';
    act(() => root.render(menu()));
    expect(document.querySelector('[role="menuitem"]')?.getAttribute('data-testid')).toBe(
      'message-disposition-trigger',
    );
    expect(document.querySelector('[role="dialog"]')?.className).toContain('--shell-paper');
  });

  it('expands a truncated classic source pill without jumping, and keeps jump a separate action', () => {
    act(() =>
      root.render(
        <ReplyPill
          replyPreview={{
            from: { kind: 'agent', catId: 'opus' },
            senderCatId: 'opus',
            content: 'long source '.repeat(30),
          }}
          replyToId="source-1"
          getCatById={getCatById}
        />,
      ),
    );
    const button = required(container.querySelector('button'));
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(focusLineageMessage).not.toHaveBeenCalled();
    const jump = required([...container.querySelectorAll('button')].find((item) => item.textContent === '跳到原文'));
    expect(jump).toBeTruthy();
    act(() => jump.click());
    expect(focusLineageMessage).toHaveBeenCalledWith('source-1');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it.each([
    { content: 'short' },
    { content: '', deleted: true as const },
  ])('does not create an expansion for short or deleted sources', (preview) => {
    overflowing = false;
    act(() =>
      root.render(
        <ReplyPill
          replyPreview={{ from: { kind: 'agent', catId: 'opus' }, senderCatId: 'opus', ...preview }}
          replyToId="source-1"
          getCatById={getCatById}
        />,
      ),
    );
    const button = required(container.querySelector('button'));
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    act(() => button.click());
    expect(focusLineageMessage).toHaveBeenCalledWith('source-1');
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('retains the v2 source-pill jump behavior', () => {
    presentation = 'v2';
    act(() =>
      root.render(
        <ReplyPill
          replyPreview={{ from: { kind: 'agent', catId: 'opus' }, senderCatId: 'opus', content: 'source' }}
          replyToId="source-1"
          getCatById={getCatById}
        />,
      ),
    );
    act(() => required(container.querySelector('button')).click());
    expect(focusLineageMessage).toHaveBeenCalledWith('source-1');
    expect(container.textContent).not.toContain('跳到原文');
  });

  it.each([
    [{ kind: 'user', userId: 'owner' }, '--color-cocreator-primary'],
    [{ kind: 'agent', catId: 'opus' }, '--color-opus-primary'],
  ] as const)('paints an appended source in its own theme, not the receiver theme', (from, token) => {
    const input: ChatMessage = { id: 'source-1', from, type: 'user', content: 'append', timestamp: 2000 };
    const response: ChatMessage = {
      id: 'response-1',
      from: { kind: 'agent', catId: 'codex' },
      type: 'assistant',
      content: 'reply',
      timestamp: 1000,
      lifecycle: {
        kind: 'response',
        orderKey: '1',
        invocationId: 'inv',
        targetId: 'codex',
        inputEntryIds: ['first', 'append'],
        inputMessageIds: ['initial', input.id],
        status: 'completed',
        startedAt: 1000,
        completedAt: 3000,
      },
    };
    act(() =>
      root.render(<AppendedInputReceipts response={response} timelineMessages={[input]} getCatById={getCatById} />),
    );
    const dot = required(container.querySelector('[data-appended-input-id] button > span[aria-hidden="true"]'));
    expect(dot.getAttribute('style')).toContain(token);
    expect(dot.getAttribute('style')).not.toContain('--color-codex-primary');
  });
});
