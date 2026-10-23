import type { MessageDispositionPreferenceSnapshot } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { writeShellLanguage } from '@/components/shell/shell-language';
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
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
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
        messageDeliveryCapabilities: { guideReply: true },
      },
      {
        id: 'sol',
        displayName: '缅因猫',
        variantLabel: 'sol',
        mentionPatterns: ['@sol'],
        messageDeliveryCapabilities: { guideReply: true },
      },
      {
        id: 'kimi',
        displayName: '狸花猫',
        mentionPatterns: ['@kimi'],
        messageDeliveryCapabilities: { guideReply: false },
      },
      {
        id: 'astra',
        displayName: '缅因猫',
        variantLabel: 'astra',
        mentionPatterns: ['@astra'],
        messageDeliveryCapabilities: { guideReply: true },
      },
      { id: 'unknown', displayName: '未知成员', mentionPatterns: [] },
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
    writeShellLanguage('zh');
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
    writeShellLanguage('zh');
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
      if (!document.querySelector('[data-testid="composer-add-menu"]')) {
        document.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click();
      }
      await Promise.resolve();
    });
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="message-disposition-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="message-disposition-panel"]')).not.toBeNull();
  }

  async function chooseContinueCurrent() {
    await openDisposition();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-disposition-option="continue_current"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function typeAndSend(value: string) {
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => setTextarea(textarea, value));
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('uses the selected mode for one send then returns to the inherited default without a preference write', async () => {
    const onSend = vi.fn(async () => true);
    await renderThreadInput({ threadId: 'thread-1', onSend, hasActiveInvocation: true });
    await chooseContinueCurrent();
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '接着当前工作',
    );
    await typeAndSend('顺手看一下问题 B');
    expect(onSend).toHaveBeenLastCalledWith(
      '顺手看一下问题 B',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
    );
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '作为下一件工作',
    );
    await typeAndSend('下一条按默认');
    expect(onSend).toHaveBeenLastCalledWith('下一条按默认', undefined, undefined, undefined);
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('retains the one-shot choice when admission refuses the message', async () => {
    const onSend = vi.fn(async () => false);
    await renderThreadInput({ threadId: 'thread-2', onSend, hasActiveInvocation: true });
    await chooseContinueCurrent();
    await typeAndSend('网络失败也别吃掉我的选择');
    expect(onSend).toHaveBeenCalledWith(
      '网络失败也别吃掉我的选择',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
    );
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '接着当前工作',
    );
  });

  it('uses one normal Send button during active work and lets Queue apply the selected strategy', async () => {
    const onSend = vi.fn(async () => true);
    useChatStore.setState({
      targetCats: ['astra'],
      activeInvocations: {
        opus: { catId: 'opus', mode: 'execute' },
        sol: { catId: 'sol', mode: 'execute' },
        kimi: { catId: 'kimi', mode: 'execute' },
      },
    });
    await renderThreadInput({ threadId: 'thread-active', onSend, hasActiveInvocation: true });
    expect(document.querySelector('textarea')?.placeholder).toBe(
      '想调整方向？可直接给布偶猫/缅因猫（sol）发消息，引导回复。',
    );
    await chooseContinueCurrent();
    expect(document.querySelector('textarea')?.placeholder).toBe(
      '想调整方向？可直接给布偶猫/缅因猫（sol）发消息，引导回复。',
    );
    expect(document.querySelector('[data-testid="active-invocation-banner"]')).toBeNull();

    act(() => setTextarea(document.querySelector('textarea') as HTMLTextAreaElement, '继续补充约束'));
    expect(document.querySelectorAll('button[aria-label="Send message"]')).toHaveLength(1);
    expect(document.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Steer 发送选项"]')).toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      '继续补充约束',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'continue_current',
    );
    act(() =>
      useChatStore.setState({
        activeInvocations: { kimi: { catId: 'kimi', mode: 'execute' }, unknown: { catId: 'unknown', mode: 'execute' } },
      }),
    );
    expect(document.querySelector('textarea')?.placeholder).toBe('输入消息... (@ 召唤猫猫 · /thread 引用对话)');
  });

  it.each([
    'classic',
    'v2',
  ] as const)('uses canonical active members ahead of targets and custom copy in %s', async (presentation) => {
    useChatStore.setState({
      targetCats: ['opus', 'sol'],
      activeInvocations: { stale: { catId: 'opus', mode: 'execute' } },
    });
    useActiveExecutionStore.setState({
      executionsByKey: {
        astra: {
          kind: 'live_invocation',
          executionId: 'active-astra',
          threadId: 'thread-canonical',
          threadTitle: null,
          catId: 'astra',
          startedAt: 1,
          cancelability: { state: 'not_cancelable', reason: 'control_plane_unavailable' },
        },
      },
    });
    await renderThreadInput({
      threadId: 'thread-canonical',
      onSend: vi.fn(),
      hasActiveInvocation: true,
      presentation,
      placeholder: '自定义空闲提示',
    });
    expect(document.querySelector('textarea')?.placeholder).toBe(
      '想调整方向？可直接给缅因猫（astra）发消息，引导回复。',
    );
    act(() => useChatStore.setState({ targetCats: ['kimi'] }));
    expect(document.querySelector('textarea')?.placeholder).toBe(
      '想调整方向？可直接给缅因猫（astra）发消息，引导回复。',
    );
    act(() => {
      useActiveExecutionStore.getState().reset();
      useChatStore.setState({ activeInvocations: {}, hasActiveInvocation: false });
    });
    expect(document.querySelector('textarea')?.placeholder).toBe('自定义空闲提示');
  });

  it.each(['classic', 'v2'] as const)('hides the one-shot choice while idle in %s', async (presentation) => {
    await renderThreadInput({ threadId: 'idle', onSend: vi.fn(), hasActiveInvocation: false, presentation });
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click());
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')).toBeNull();
  });

  it('offers only a one-message choice and no persistent scopes', async () => {
    await renderThreadInput({ threadId: 'thread-simple', onSend: vi.fn(), hasActiveInvocation: true });
    await openDisposition();
    expect(document.querySelector('[data-disposition-scope]')).toBeNull();
    expect(document.body.textContent).toContain('仅这一次');
  });

  it('hides the choice for idle whisper recipients while another cat is working', async () => {
    useChatStore.setState({ activeInvocations: { opus: { catId: 'opus', mode: 'execute' } } });
    await renderThreadInput({ threadId: 'idle-whisper', onSend: vi.fn(), hasActiveInvocation: true });
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="composer-whisper"]')?.click());
    const idle = [...container.querySelectorAll<HTMLButtonElement>('.absolute.bottom-full button')].find((button) =>
      button.textContent?.includes('缅因猫（sol）'),
    );
    expect(idle).toBeDefined();
    await act(async () => idle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click());
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')).toBeNull();
  });

  it('preserves an inherited global default after consuming a different one-shot choice', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse(
        dispositionSnapshot({ global: 'continue_current', effective: 'continue_current', source: 'global' }),
      ),
    );
    const onSend = vi.fn(async () => true);
    await renderThreadInput({ threadId: 'global-default', onSend, hasActiveInvocation: true });
    await openDisposition();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-disposition-option="next_work"]')?.click());
    await typeAndSend('只有这一条排下一件');
    expect(onSend).toHaveBeenLastCalledWith(
      '只有这一条排下一件',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'next_work',
    );
    expect(
      document.querySelector('[data-testid="message-disposition-trigger"]')?.getAttribute('data-disposition-source'),
    ).toBe('global');
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '接着当前工作',
    );
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('does not consume a newer choice when an older admission resolves', async () => {
    let accept: ((accepted: boolean) => void) | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    await renderThreadInput({ threadId: 'pending-send', onSend, hasActiveInvocation: true });
    await chooseContinueCurrent();
    await typeAndSend('first');
    await openDisposition();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-disposition-option="next_work"]')?.click());
    await act(async () => {
      accept?.(true);
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="message-disposition-trigger"]')?.getAttribute('data-disposition-source'),
    ).toBe('once');
    expect(document.querySelector('[data-testid="message-disposition-trigger"]')?.textContent).toContain(
      '作为下一件工作',
    );
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
            activeInvocationGuidance: 'unsupported',
          },
        },
      },
    });
    await renderThreadInput({ threadId: 'thread-6', onSend: vi.fn(), hasActiveInvocation: true });
    await openDisposition();

    expect(document.querySelector<HTMLButtonElement>('[data-disposition-option="continue_current"]')?.disabled).toBe(
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
    await renderThreadInput({ threadId: 'thread-inherited', onSend: vi.fn(), hasActiveInvocation: true });
    await openDisposition();

    expect(document.querySelector('[data-testid="message-disposition-scope-state"]')).toBeNull();
    const selected = document.querySelector('[data-disposition-option="continue_current"]');
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-disposition-scope]')).toBeNull();
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

    await renderThreadInput({ threadId: 'thread-a', onSend: vi.fn(), hasActiveInvocation: true });
    await openDisposition();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-disposition-option="next_work"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await renderThreadInput({ threadId: 'thread-b', onSend: vi.fn(), hasActiveInvocation: true });
    await act(async () => {
      if (!document.querySelector('[data-testid="message-disposition-trigger"]')) {
        document.querySelector<HTMLButtonElement>('button[aria-label="添加"]')?.click();
      }
      await Promise.resolve();
    });
    const triggerB = document.querySelector<HTMLButtonElement>('[data-testid="message-disposition-trigger"]');
    expect(triggerB?.textContent).toContain('作为下一件工作');
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
