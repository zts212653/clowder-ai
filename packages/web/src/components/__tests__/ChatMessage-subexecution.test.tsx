import type { ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

const childBase = {
  v: 1 as const,
  kind: 'subexecution' as const,
  subexecutionId: 'child-thread-bohr',
  rootExecutionId: 'root-session-astra',
  parentExecutionId: 'root-session-astra',
  rootTurnId: 'root-turn-astra',
  parentTurnId: 'root-turn-astra',
  turnId: 'child-turn-bohr',
  agentPath: '/root/review_knowledge_delta',
  nickname: 'Bohr',
  depth: 1,
  provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'subAgentActivity' } as const,
};

const childEvents: ProviderSubexecutionSemanticEvent[] = [
  {
    ...childBase,
    id: 'subexecution:child-thread-bohr:started',
    stage: 'started',
    occurredAt: 100,
  },
  {
    ...childBase,
    id: 'subexecution:child-thread-bohr:commentary',
    stage: 'message',
    occurredAt: 110,
    messagePhase: 'commentary',
    content: '正在逐段核对 ASR 与 Markdown。',
  },
  {
    ...childBase,
    id: 'subexecution:child-thread-bohr:final',
    stage: 'message',
    occurredAt: 120,
    messagePhase: 'final_answer',
    content: 'Approve：内容与 ASR 一致。',
  },
  {
    ...childBase,
    id: 'subexecution:child-thread-bohr:completed',
    stage: 'completed',
    occurredAt: 130,
  },
];

describe('F307 root and child agent presentation', () => {
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
    useChatStore.setState({
      currentThreadId: 'thread-subexecution',
      messages: [],
      threads: [],
      isLoadingThreads: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the root final primary and labels a concrete child final as child-authored', () => {
    const message: ChatMessageData = {
      id: 'root-final-message',
      type: 'assistant',
      catId: 'codex-astra',
      content: '主 Astra 最终交付：Markdown 已提交 e240018bd7。',
      timestamp: 140,
      metadata: {
        provider: 'openai',
        model: 'gpt-6-astra',
        sessionId: 'root-session-astra',
        subexecutionEvents: childEvents,
      },
    };

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-subexecution" getCatById={() => undefined} />);
    });

    expect(container.querySelector('[data-agent-role="root"]')?.textContent).toContain('主 agent');
    expect(container.textContent).toContain('主 Astra 最终交付');

    const child = container.querySelector('[data-subexecution-id="child-thread-bohr"]');
    expect(child).not.toBeNull();
    expect(child?.textContent).toContain('子 agent');
    expect(child?.textContent).toContain('Bohr');
    expect(child?.textContent).toContain('/root/review_knowledge_delta');
    expect(child?.textContent).toContain('已完成');
    expect(child?.querySelector('[data-subexecution-message-phase="commentary"]')?.textContent).toContain(
      '正在逐段核对',
    );
    expect(child?.querySelector('[data-subexecution-message-phase="final_answer"]')?.textContent).toContain(
      '子 agent 最终回报',
    );
    expect(child?.textContent).toContain('Approve：内容与 ASR 一致。');
    expect(child?.textContent).not.toContain('审阅者');
  });

  it('keeps a bodyless root carrier visible without promoting child prose to root content', () => {
    const message: ChatMessageData = {
      id: 'root-child-only-message',
      type: 'assistant',
      catId: 'codex-astra',
      content: '',
      timestamp: 140,
      metadata: {
        provider: 'openai',
        model: 'gpt-6-astra',
        subexecutionEvents: childEvents,
      },
    };

    act(() => {
      root.render(<ChatMessage message={message} threadId="thread-subexecution" getCatById={() => undefined} />);
    });

    expect(container.querySelector('[data-message-id="root-child-only-message"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-role="root"]')).not.toBeNull();
    expect(container.querySelector('[data-subexecution-id="child-thread-bohr"]')).not.toBeNull();
  });
});
