import type { ContentModificationReceiptV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

/**
 * F309: the Host receipt a content modification leaves in the conversation is a system message whose stored text
 * carries the request, candidate and receipt coordinates. The conversation draws it as one plain line instead.
 */
const REQUEST_ID = `f309-modification-${'a'.repeat(64)}`;
const RAW_TEXT = [
  '[Host 作品修改回执]',
  '候选修改已返回，可打开对照后决定。原文件尚未因此改变。',
  `requestId: ${REQUEST_ID}`,
  'candidateRef: candidate-secret',
  'receiptRef: receipt-secret',
  '这是系统投影，不是新的修改授权；打开后以当前请求详情为准。',
].join('\n');

const receipt: ContentModificationReceiptV1 = {
  v: 1,
  requestId: REQUEST_ID,
  sourceMessageId: 'human-source',
  targetCatId: 'codex-sol',
  taskId: 'task-1',
  state: 'candidate',
  candidateRef: 'candidate-secret',
  receiptRef: 'receipt-secret',
  observedAt: 1,
  followUp: { kind: 'none', reason: 'not_applicable' },
};

function hostMessage(extra: ChatMessageData['extra']): ChatMessageData {
  return { id: 'host-receipt-1', type: 'system', content: RAW_TEXT, timestamp: 1, extra };
}

describe('ChatMessage: Host receipt of a content modification', () => {
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
    useChatStore.setState({ currentThreadId: 'thread-1', messages: [], threads: [], isLoadingThreads: false });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(message: ChatMessageData) {
    act(() => {
      root.render(
        <ChatMessage
          message={message}
          threadId="thread-1"
          getCatById={(id) => (id === 'codex-sol' ? ({ id, displayName: '烁烁' } as never) : undefined)}
          onEditCoCreator={() => undefined}
        />,
      );
    });
  }

  it('draws the receipt as one plain line in the accepted wording, not the stored text', () => {
    render(hostMessage({ systemKind: 'content_modification_receipt', contentModificationReceiptV1: receipt }));
    const text = container.textContent ?? '';
    expect(text).toContain('烁烁提交了修改');
    expect(text).toContain('原文件尚未因此改变。');
    expect(text).not.toMatch(/requestId|candidateRef|receiptRef|candidate-secret|receipt-secret|f309-modification/);
    expect(container.querySelector('[data-message-id="host-receipt-1"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="打开对照"]')).not.toBeNull();
  });

  it('does not impersonate the person: it is a centred Host line, not the right-aligned bubble of your own message', () => {
    render(hostMessage({ systemKind: 'content_modification_receipt', contentModificationReceiptV1: receipt }));
    const wrapper = container.querySelector('[data-message-id="host-receipt-1"]');
    expect(wrapper?.className).toContain('justify-center');
    expect(wrapper?.className).not.toContain('justify-end');
  });

  it('keeps the plain system line when the carrier is not a valid Host receipt, so nothing is lost', () => {
    render(
      hostMessage({
        systemKind: 'content_modification_receipt',
        contentModificationReceiptV1: { ...receipt, state: 'bogus' } as never,
      }),
    );
    expect(container.textContent).toContain('[Host 作品修改回执]');
    expect(container.querySelector('[data-testid="modification-progress"]')).toBeNull();
  });

  it('does not swallow another system message that merely carries a schema-valid receipt payload', () => {
    // Host identity needs the systemKind as well as a valid payload; otherwise any system line could hide its text.
    for (const systemKind of [undefined, 'context_briefing'] as const) {
      render(
        hostMessage({
          ...(systemKind ? { systemKind } : {}),
          contentModificationReceiptV1: receipt,
        }),
      );
      expect(container.textContent).toContain('[Host 作品修改回执]');
      expect(container.querySelector('[data-testid="modification-progress"]')).toBeNull();
    }
  });

  it('keeps retired A2A routing rows hidden even if they carry a receipt-shaped payload', () => {
    render(hostMessage({ systemKind: 'a2a_routing', contentModificationReceiptV1: receipt }));
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-testid="modification-progress"]')).toBeNull();
  });

  it('leaves every other system message alone', () => {
    render({ id: 'sys-1', type: 'system', content: '系统提示一条', timestamp: 1 });
    expect(container.textContent).toContain('系统提示一条');
    expect(container.querySelector('[data-testid="modification-progress"]')).toBeNull();
  });
});
