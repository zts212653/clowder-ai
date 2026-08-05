import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
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
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], isLoading: false }) }));

const mockApiFetch = vi.fn((path: string, init?: RequestInit) => globalThis.fetch(path, init));
vi.mock('@/utils/api-client', () => ({
  API_URL: '',
  apiFetch: (...args: [string, RequestInit?]) => mockApiFetch(...args),
}));

const productSnapshot = {
  productDefault: 'next_work',
  global: null,
  thread: null,
  effective: 'next_work',
  source: 'product',
  onboardingSeen: false,
};

function setTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('F264 author message disposition selector', () => {
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
    mockApiFetch.mockClear();
    useChatStore.setState({
      targetCats: ['opus'],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'openai_codex',
            carrier: 'codex_app_server',
            deliverySemantics: 'exact_active_turn',
          },
        },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const snapshot =
        body?.scope === 'thread'
          ? { ...productSnapshot, thread: body.disposition, effective: body.disposition, source: 'thread' }
          : body?.scope === 'onboarding'
            ? { ...productSnapshot, onboardingSeen: true }
            : productSnapshot;
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function chooseContinueCurrent() {
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    act(() => {
      (container.querySelector('[data-disposition-option="continue_current"]') as HTMLButtonElement).click();
    });
    return trigger;
  }

  async function typeAndSend(value: string) {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => setTextarea(textarea, value));
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('appears only for live work and consumes a one-shot override after successful admission', async () => {
    const onSend = vi.fn(async () => true);
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend, hasActiveInvocation: false }));
    });
    expect(container.querySelector('[data-testid="message-disposition-trigger"]')).toBeNull();

    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend, hasActiveInvocation: true }));
      await Promise.resolve();
    });
    const trigger = await chooseContinueCurrent();
    expect(trigger.textContent).toContain('接着当前工作');
    await typeAndSend('顺手看一下问题 B');

    expect(onSend).toHaveBeenCalledWith(
      '顺手看一下问题 B',
      undefined,
      undefined,
      'queue',
      undefined,
      'continue_current',
    );
    expect(trigger.textContent).toContain('下一件工作');
  });

  it('retains a one-shot override when admission fails', async () => {
    const onSend = vi.fn(async () => false);
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-2', onSend, hasActiveInvocation: true }));
      await Promise.resolve();
    });
    const trigger = await chooseContinueCurrent();
    await typeAndSend('网络失败也别吃掉我的选择');

    expect(onSend).toHaveBeenCalledWith(
      '网络失败也别吃掉我的选择',
      undefined,
      undefined,
      'queue',
      undefined,
      'continue_current',
    );
    expect(trigger.textContent).toContain('接着当前工作');
  });

  it('keeps Steer as a distinct primary-trigger action without author disposition', async () => {
    const onSend = vi.fn(async () => true);
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-3', onSend, hasActiveInvocation: true }));
      await Promise.resolve();
    });
    const trigger = await chooseContinueCurrent();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => setTextarea(textarea, '现在就换轨'));
    await act(async () => {
      (container.querySelector('[aria-label="强制发送"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith('现在就换轨', undefined, undefined, 'force', undefined, undefined);
    expect(trigger.textContent).toContain('接着当前工作');
  });

  it('can persist the choice for this thread instead of changing every send', async () => {
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-4', onSend: vi.fn(), hasActiveInvocation: true }));
      await Promise.resolve();
    });
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    act(() => (container.querySelector('[data-disposition-scope="thread"]') as HTMLButtonElement).click());
    await act(async () => {
      (container.querySelector('[data-disposition-option="continue_current"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const put = mockApiFetch.mock.calls.find((call) => {
      if (call[0] !== '/api/config/message-disposition' || call[1]?.method !== 'PUT') return false;
      return JSON.parse(String(call[1].body)).scope === 'thread';
    });
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      scope: 'thread',
      threadId: 'thread-4',
      disposition: 'continue_current',
    });
    expect(trigger.textContent).toContain('接着当前工作');
  });

  it('shows contextual onboarding only on the first meaningful open', async () => {
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-5', onSend: vi.fn(), hasActiveInvocation: true }));
      await Promise.resolve();
    });
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;

    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="message-disposition-onboarding"]')).not.toBeNull();

    act(() => trigger.click());
    act(() => trigger.click());
    expect(container.querySelector('[data-testid="message-disposition-onboarding"]')).toBeNull();
  });

  it('fails closed and explains unsupported or undeclared provider carriers', async () => {
    useChatStore.setState({
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'anthropic',
            carrier: 'claude_print_sdk',
            deliverySemantics: 'unsupported',
          },
        },
      },
    });
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-6', onSend: vi.fn(), hasActiveInvocation: true }));
      await Promise.resolve();
    });
    const trigger = container.querySelector('[data-testid="message-disposition-trigger"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('下一件工作');
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const continueOption = container.querySelector('[data-disposition-option="continue_current"]') as HTMLButtonElement;
    expect(continueOption.disabled).toBe(true);
    expect(container.textContent).toContain('当前接入不支持本轮读取');

    act(() => {
      useChatStore.setState({
        catInvocations: { opus: { invocationId: 'inv-active' } },
      });
    });
    await act(async () => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-6', onSend: vi.fn(), hasActiveInvocation: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('能力未声明');
  });
});
