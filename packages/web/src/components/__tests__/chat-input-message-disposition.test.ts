import type { MessageDispositionPreferenceSnapshot } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/icons/SendIcon', () => ({ SendIcon: () => React.createElement('span', null, 'send') }));
vi.mock('@/components/icons/LoadingIcon', () => ({ LoadingIcon: () => React.createElement('span', null, 'loading') }));
vi.mock('@/components/icons/AttachIcon', () => ({ AttachIcon: () => React.createElement('span', null, 'attach') }));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/components/AttachmentPreview', () => ({ AttachmentPreview: () => null }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (file: File) => Promise.resolve(file) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        mentionPatterns: ['@布偶猫', '@opus'],
        roleDescription: 'reviewer',
        avatar: '/opus.png',
        roster: { available: true },
        isDefaultResponder: true,
      },
    ],
    isLoading: false,
  }),
}));

const mockApiFetch = vi.fn((path: string, init?: RequestInit) => globalThis.fetch(path, init));
vi.mock('@/utils/api-client', () => ({
  API_URL: '',
  apiFetch: (...args: [string, RequestInit?]) => mockApiFetch(...args),
}));

const productSnapshot: MessageDispositionPreferenceSnapshot = {
  productDefault: 'next_work',
  global: null,
  thread: null,
  effective: 'next_work',
  source: 'product',
};

function dispositionSnapshot(
  overrides: Partial<MessageDispositionPreferenceSnapshot> = {},
): MessageDispositionPreferenceSnapshot {
  return { ...productSnapshot, ...overrides };
}

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

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
    useChatStore.setState({ targetCats: ['opus'], activeInvocations: {}, catInvocations: {} });
    useActiveExecutionStore.getState().reset();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const snapshot =
        body?.scope === 'thread'
          ? { ...productSnapshot, thread: body.disposition, effective: body.disposition, source: 'thread' }
          : productSnapshot;
      return jsonResponse(snapshot);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderThreadInput(props: React.ComponentProps<typeof ChatInput>) {
    await act(async () => {
      useChatStore.setState({
        currentThreadId: props.threadId,
        hasActiveInvocation: props.hasActiveInvocation ?? false,
      });
      root.render(React.createElement(ChatInput, props));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function openDisposition() {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click();
      await Promise.resolve();
    });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="message-disposition-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="message-disposition-panel"]')).not.toBeNull();
  }

  async function chooseContinueCurrent() {
    await openDisposition();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-disposition-option="continue_current"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
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

  it('persists the Thread strategy while idle and lets server admission resolve it', async () => {
    const onSend = vi.fn(async () => true);
    await renderThreadInput({ threadId: 'thread-1', onSend, hasActiveInvocation: false });
    await chooseContinueCurrent();

    expect(container.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '引导当前回复',
    );
    await typeAndSend('顺手看一下问题 B');
    expect(onSend).toHaveBeenCalledWith('顺手看一下问题 B', undefined, undefined, undefined);
    expect(container.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '引导当前回复',
    );
  });

  it('retains the persistent Thread strategy when admission fails', async () => {
    const onSend = vi.fn(async () => false);
    await renderThreadInput({ threadId: 'thread-2', onSend, hasActiveInvocation: false });
    await chooseContinueCurrent();
    await typeAndSend('网络失败也别吃掉我的选择');

    expect(onSend).toHaveBeenCalledWith('网络失败也别吃掉我的选择', undefined, undefined, undefined);
    expect(container.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '引导当前回复',
    );
  });

  it('uses one normal Send button during active work and lets Queue apply the selected strategy', async () => {
    const onSend = vi.fn(async () => true);
    await renderThreadInput({ threadId: 'thread-active', onSend, hasActiveInvocation: true });
    await chooseContinueCurrent();

    act(() => setTextarea(container.querySelector('textarea') as HTMLTextAreaElement, '继续补充约束'));
    expect(container.querySelectorAll('button[aria-label="Send message"]')).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Steer 发送选项"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith('继续补充约束', undefined, undefined, undefined);
  });

  it('can persist the choice for this thread', async () => {
    await renderThreadInput({ threadId: 'thread-4', onSend: vi.fn(), hasActiveInvocation: false });
    await openDisposition();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-disposition-option="continue_current"]')?.click();
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
    expect(container.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '引导当前回复',
    );
  });

  it('offers only persistent scopes without inheritance controls or redundant explanatory copy', async () => {
    await renderThreadInput({ threadId: 'thread-simple', onSend: vi.fn(), hasActiveInvocation: false });
    await openDisposition();

    expect(container.querySelector('[data-disposition-scope="once"]')).toBeNull();
    expect(container.querySelector('[data-disposition-scope="thread"]')).not.toBeNull();
    expect(container.querySelector('[data-disposition-scope="global"]')).not.toBeNull();
    expect(container.textContent).not.toContain('恢复继承');
    expect(container.textContent).not.toContain('消息入队后按目标的实时状态执行');
    expect(container.querySelector('[data-testid="message-disposition-onboarding"]')).toBeNull();
  });

  it('keeps strategy independent of the current carrier capability', async () => {
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
    await renderThreadInput({ threadId: 'thread-6', onSend: vi.fn(), hasActiveInvocation: true });
    await openDisposition();

    expect(container.querySelector<HTMLButtonElement>('[data-disposition-option="continue_current"]')?.disabled).toBe(
      false,
    );
    expect(container.textContent).not.toContain('当前接入不支持');
    expect(container.textContent).not.toContain('能力未声明');
  });

  it('shows the inherited effective value as the selected strategy without explanatory copy', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse(
        dispositionSnapshot({
          global: 'continue_current',
          effective: 'continue_current',
          source: 'global',
        }),
      ),
    );
    await renderThreadInput({ threadId: 'thread-inherited', onSend: vi.fn(), hasActiveInvocation: false });
    await openDisposition();

    expect(container.querySelector('[data-testid="message-disposition-scope-state"]')).toBeNull();
    const selected = container.querySelector('[data-disposition-option="continue_current"]');
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    expect(selected?.className).toContain('bg-cafe-surface-sunken');
    expect(container.querySelector('[aria-label="偏好作用域"]')?.className).toContain('bg-cafe-surface');
  });

  it('resets Thread A presentation before Thread B hydration completes', async () => {
    let resolveThreadB: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const path = String(input);
      if (path.includes('threadId=thread-a')) {
        return Promise.resolve(
          jsonResponse(
            dispositionSnapshot({
              thread: 'continue_current',
              effective: 'continue_current',
              source: 'thread',
            }),
          ),
        );
      }
      if (path.includes('threadId=thread-b')) {
        return new Promise<Response>((resolve) => {
          resolveThreadB = resolve;
        });
      }
      return Promise.resolve(jsonResponse(productSnapshot));
    });

    await renderThreadInput({ threadId: 'thread-a', onSend: vi.fn(), hasActiveInvocation: false });
    await openDisposition();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-disposition-option="next_work"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await renderThreadInput({ threadId: 'thread-b', onSend: vi.fn(), hasActiveInvocation: false });
    await act(async () => {
      if (!container.querySelector('[data-testid="message-disposition-trigger"]')) {
        container.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click();
      }
      await Promise.resolve();
    });
    const triggerB = container.querySelector<HTMLButtonElement>('[data-testid="message-disposition-trigger"]');
    expect(triggerB?.textContent).toContain('排队等待');
    expect(triggerB?.getAttribute('data-disposition-source')).toBe('product');

    await act(async () => {
      resolveThreadB?.(
        jsonResponse(
          dispositionSnapshot({
            global: 'continue_current',
            effective: 'continue_current',
            source: 'global',
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(triggerB?.getAttribute('data-disposition-source')).toBe('global');
  });
});
