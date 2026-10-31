import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ChatInput, threadContextAttachmentDrafts, threadReplyDrafts } from '../ChatInput';
import { ChatInputActionButton } from '../ChatInputActionButton';
import { writeShellLanguage } from '../shell/shell-language';

const voice = vi.hoisted(() => ({
  state: 'idle',
  transcript: '',
  partialTranscript: '',
  error: null,
  duration: 0,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}));
vi.mock('@/hooks/useVoiceInput', () => ({ useVoiceInput: () => voice }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, getCatsByBreed: () => new Map() }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => new Response('{}', { status: 200 })) }));

let container: HTMLDivElement;
let root: Root;
const onSend = vi.fn();
const onProject = vi.fn();
const onPreferredCat = vi.fn();

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  vi.clearAllMocks();
  threadContextAttachmentDrafts.clear();
  threadReplyDrafts.clear();
  writeShellLanguage('zh');
  voice.state = 'idle';
  voice.transcript = '';
  voice.partialTranscript = '';
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    hasActiveInvocation: false,
    activeInvocations: {},
    catInvocations: {},
    targetCats: [],
    replyToMessage: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  threadContextAttachmentDrafts.clear();
  threadReplyDrafts.clear();
  writeShellLanguage('zh');
  vi.restoreAllMocks();
});

function renderComposer(presentation: 'classic' | 'v2' = 'v2') {
  act(() =>
    root.render(
      <ChatInput
        presentation={presentation}
        onSend={onSend}
        composerContext={
          <>
            <button type="button" onClick={onProject}>
              Project
            </button>
            <button type="button" onClick={onPreferredCat}>
              Preferred cat
            </button>
          </>
        }
      />,
    ),
  );
}
function typeInto(text: string) {
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('Missing textarea');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return textarea;
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label,
  );
}

describe('v2 two-level composer', () => {
  it('anchors typed mention choices to the composer card instead of the full-width chat rail', () => {
    renderComposer();
    typeInto('@');
    const menu = [...container.querySelectorAll('div')].find(
      (el) => el.textContent?.includes('↑↓ 选择') && el.classList.contains('absolute'),
    );
    expect(menu).toBeDefined();
    expect(menu?.closest('[data-testid="chat-input-composer-row"]')).not.toBeNull();
  });

  it('keeps the send strategy chosen in + for this thread instead of one message', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      const saved = init?.method === 'PUT';
      return new Response(
        JSON.stringify({
          productDefault: 'next_work',
          global: null,
          thread: saved ? 'continue_current' : null,
          effective: saved ? 'continue_current' : 'next_work',
          source: saved ? 'thread' : 'product',
        }),
        { status: 200 },
      );
    });
    useChatStore.setState({
      hasActiveInvocation: true,
      activeInvocations: { 'strategy-run': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
    });
    await act(async () => root.render(<ChatInput presentation="v2" threadId="thread-strategy" onSend={onSend} />));
    act(() => button('添加')?.click());
    const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="message-disposition-trigger"]');
    expect(trigger()?.textContent).toContain('发送策略：排队等待');
    act(() => trigger()?.click());
    expect(document.querySelectorAll('[data-disposition-scope]')).toHaveLength(2);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-disposition-option="continue_current"]')?.click(),
    );
    const write = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      scope: 'thread',
      threadId: 'thread-strategy',
      disposition: 'continue_current',
    });
    expect(trigger()?.textContent).toContain('发送策略：引导当前回复');
    typeInto('继续这个方向');
    await act(async () => button('发送消息')?.click());
    typeInto('再补一处');
    await act(async () => button('发送消息')?.click());
    expect(onSend.mock.calls.map((call) => call[6])).toEqual([undefined, undefined]);
  });
  it('keeps mobile controls on one row and clips header and draft dividers inside the card', () => {
    threadReplyDrafts.set('thread-layout', {
      id: 'message-parent',
      content: 'quoted parent',
      senderCatId: null,
      threadId: 'thread-layout',
    });
    act(() =>
      root.render(
        <ChatInput
          presentation="v2"
          threadId="thread-layout"
          onSend={onSend}
          composerHeader={<input aria-label="Conversation name" />}
          composerContext={<button type="button">Project and routing</button>}
        />,
      ),
    );

    const card = container.querySelector('[data-testid="chat-input-composer-row"]');
    const header = container.querySelector('[data-testid="chat-composer-header"]');
    const extras = container.querySelector('[data-testid="chat-composer-draft-extras"]');
    const context = container.querySelector('[data-testid="chat-composer-context"]');
    expect(card?.className).toContain('relative');
    expect(header?.className).toContain('-mx-2');
    expect(header?.className).not.toContain('-mx-3');
    expect(extras?.className).toContain('-mx-2');
    expect(extras?.className).not.toContain('-mx-3');
    expect(context?.className).toContain('max-sm:flex-nowrap');
    expect(context?.className).not.toContain('max-sm:flex-wrap');
    expect(context?.className).toContain('max-sm:gap-2');
    expect(context?.className).toContain('max-sm:pl-1.5');
    expect(container.querySelector('[data-testid="composer-routing-root"]')?.getAttribute('data-layout')).toBe(
      'compact',
    );
  });

  it('hosts project and preferred-send-cat controls without owning their state, only in v2', () => {
    renderComposer();
    expect(button('Project')).toBeDefined();
    expect(button('Preferred cat')).toBeDefined();
    act(() => {
      button('Project')?.click();
      button('Preferred cat')?.click();
    });
    expect(onProject).toHaveBeenCalledOnce();
    expect(onPreferredCat).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    renderComposer('classic');
    expect(button('Project')).toBeUndefined();
    expect(button('Preferred cat')).toBeUndefined();
  });

  it('keeps both voice input and disabled send discoverable before typing', () => {
    renderComposer();
    expect(button('语音输入')).toBeDefined();
    expect(button('发送消息')?.disabled).toBe(true);
    act(() => button('语音输入')?.click());
    expect(voice.startRecording).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('can add voice to an existing draft and send the combined text', async () => {
    renderComposer();
    const textarea = typeInto('Keep my draft');
    expect(button('语音输入')).toBeDefined();
    act(() => button('语音输入')?.click());
    expect(voice.startRecording).toHaveBeenCalledOnce();
    voice.transcript = 'with speech';
    renderComposer();
    expect(textarea.value).toBe('Keep my draft with speech');
    await act(async () => button('发送消息')?.click());
    expect(onSend).toHaveBeenCalledWith('Keep my draft with speech', undefined, undefined, undefined);
  });

  it('keeps textarea identity, selection and composition across language and presentation changes', () => {
    renderComposer();
    const textarea = typeInto('尚未发送的草稿');
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(2, 4);
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    act(() => writeShellLanguage('en'));
    expect(textarea.getAttribute('aria-label')).toBe('Message');
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 4]);
    renderComposer('classic');
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('尚未发送的草稿');
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('preserves Shift+Enter and IME guards, then sends once with Enter', async () => {
    renderComposer();
    const textarea = typeInto('draft');
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('uses the existing add menu and exposes its full descriptions to keyboard focus', () => {
    renderComposer();
    act(() => button('添加')?.click());
    const upload = document.querySelector<HTMLButtonElement>('[data-testid="composer-upload"]');
    if (!upload) throw new Error('Missing upload action');
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? this === upload : matches.call(this, selector);
    });
    act(() => upload.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('图片、文档或压缩包，最多 5 个');
  });

  it('keeps restored context inside the v2 composer border while classic preserves the old sibling layout', async () => {
    const attachment = {
      v: 1 as const,
      id: 'ctx-layout',
      kind: 'thread' as const,
      threadId: 'thread-source',
      title: 'Existing context',
    };
    threadContextAttachmentDrafts.set('thread-layout', [attachment]);

    await act(async () => {
      root.render(<ChatInput presentation="v2" threadId="thread-layout" onSend={onSend} />);
      await Promise.resolve();
    });
    const v2Composer = container.querySelector('[data-testid="chat-input-composer-row"]') as HTMLElement;
    const v2Context = container.querySelector('[data-testid="context-attachment-list"]') as HTMLElement;
    expect(v2Composer.contains(v2Context)).toBe(true);
    expect(v2Context.compareDocumentPosition(container.querySelector('textarea') as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await act(async () => {
      root.render(<ChatInput presentation="classic" threadId="thread-layout" onSend={onSend} />);
      await Promise.resolve();
    });
    const classicComposer = container.querySelector('[data-testid="chat-input-composer-row"]') as HTMLElement;
    const classicContext = container.querySelector('[data-testid="context-attachment-list"]') as HTMLElement;
    expect(classicComposer.contains(classicContext)).toBe(false);
    expect(classicContext.compareDocumentPosition(classicComposer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps voice separate while recording/transcribing and blocks premature sending', () => {
    voice.state = 'recording';
    renderComposer();
    typeInto('draft');
    expect(button('停止录音')).toBeDefined();
    expect(button('发送消息')?.disabled).toBe(true);
    act(() => button('停止录音')?.click());
    expect(voice.stopRecording).toHaveBeenCalledOnce();
    voice.state = 'transcribing';
    renderComposer();
    expect(button('转写中')?.disabled).toBe(true);
    expect(button('发送消息')?.disabled).toBe(true);
  });

  it('routes a live partial transcript through the overflow recovery primitive', () => {
    voice.state = 'recording';
    voice.partialTranscript = '这是一段很长的实时转写。'.repeat(30);
    renderComposer();
    const blocks = [...container.querySelectorAll('[data-overflow-measure="block"]')];
    expect(blocks.map((node) => node.textContent)).toContain(voice.partialTranscript);
  });

  it('retains queue-send and voice as separate controls while work is running', () => {
    const onQueueSend = vi.fn();
    act(() =>
      root.render(
        <ChatInputActionButton
          presentation="v2"
          hasText
          hasActiveInvocation
          onTranscript={vi.fn()}
          onSend={onSend}
          onQueueSend={onQueueSend}
        />,
      ),
    );
    expect(button('语音输入')).toBeDefined();
    act(() => button('发送消息')?.click());
    expect(onQueueSend).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('disables add and send while an attachment is uploading, without changing the draft', () => {
    renderComposer();
    const textarea = typeInto('with an attachment');
    act(() => root.render(<ChatInput presentation="v2" onSend={onSend} uploadStatus="uploading" />));
    expect(button('发送消息')?.disabled).toBe(true);
    expect(button('添加')?.disabled).toBe(true);
    expect(textarea.value).toBe('with an attachment');
    act(() => button('发送消息')?.click());
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ['idle', false, false, 'hidden', ['语音输入', '发送消息'], ['Voice input', 'Send message']],
    ['idle', true, false, 'available', ['语音输入', '停止生成'], ['Voice input', 'Stop generation']],
    ['idle', true, false, 'pending', ['语音输入', '正在停止'], ['Voice input', 'Stopping']],
    [
      'idle',
      true,
      false,
      'unavailable',
      ['语音输入', '正在确认可停止的运行状态'],
      ['Voice input', 'Checking which work can be stopped'],
    ],
    ['recording', false, true, 'hidden', ['停止录音', '发送消息'], ['Stop recording', 'Send message']],
    ['transcribing', false, true, 'hidden', ['转写中', '发送消息'], ['Transcribing', 'Send message']],
    ['idle', true, true, 'available', ['语音输入', '发送消息'], ['Voice input', 'Send message']],
  ] as const)('updates action names in place: voice=%s, active=%s, draft=%s, stop=%s', (state, active, text, stopState, zh, en) => {
    voice.state = state;
    act(() =>
      root.render(
        <ChatInputActionButton
          presentation="v2"
          hasText={text}
          hasActiveInvocation={active}
          stopState={stopState}
          onStop={vi.fn()}
          onQueueSend={vi.fn()}
          onTranscript={vi.fn()}
          onSend={onSend}
        />,
      ),
    );
    const controls = [...container.querySelectorAll('button')];
    expect(controls.map((item) => item.getAttribute('aria-label'))).toEqual(zh);
    act(() => writeShellLanguage('en'));
    expect([...container.querySelectorAll('button')]).toEqual(controls);
    expect(controls.map((item) => item.getAttribute('aria-label'))).toEqual(en);
    act(() => writeShellLanguage('zh'));
    expect(controls.map((item) => item.getAttribute('aria-label'))).toEqual(zh);
  });
});
