import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CLOUD_BINDING_CHANGED } from '@/components/cloud-binding-events';
import { apiFetch } from '@/utils/api-client';
import {
  buttonByText,
  type Candidate,
  click,
  connected,
  FakeHost,
  flush,
  gate,
  mountPanel,
  REVIEW,
  radioFor,
  STARS,
  serveHosts,
  UNTITLED,
} from './cloud-route-test-fixtures';

/** F202 h3c-1: the thread panel connects, changes and disconnects its conversation in place. */

const mockApiFetch = vi.mocked(apiFetch);
let panel: ReturnType<typeof mountPanel>;
let container: HTMLDivElement;
const serve = (...hosts: FakeHost[]) => serveHosts(mockApiFetch, ...hosts);
const show = (threadId: string) => panel.show(threadId);
const status = () => panel.status();
const changeTo = (conversation: Candidate) => panel.changeTo(conversation);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mockApiFetch.mockReset();
  panel = mountPanel();
  container = panel.container;
});
afterEach(() => {
  panel.unmount();
  vi.restoreAllMocks();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('changing the thread’s conversation in place', () => {
  it('changes to another authorized conversation and folds back to it', async () => {
    const host = connected(STARS);
    serve(host);
    const heard = vi.fn();
    window.addEventListener(CLOUD_BINDING_CHANGED, heard);
    await show(host.threadId);

    await click(buttonByText(container, '更换'));
    expect(container.textContent).toContain('已连接当前对话');
    expect(document.activeElement).toBe(radioFor(container, STARS.conversationId));
    expect(buttonByText(container, '改用这个会话')?.disabled).toBe(true);

    await click(radioFor(container, REVIEW.conversationId));
    await click(buttonByText(container, '改用这个会话'));
    window.removeEventListener(CLOUD_BINDING_CHANGED, heard);

    expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: REVIEW.chatUrl }]);
    expect(status()).toBe('connected');
    expect(container.textContent).toContain(REVIEW.displayTitle);
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(document.activeElement).toBe(buttonByText(container, '更换'));
    // Others hear of the write; the panel does not read back its own.
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]?.[0] as CustomEvent<{ threadId: string }>).detail.threadId).toBe(host.threadId);
    expect(host.bindingReads()).toHaveLength(1);
  });

  it('connects a thread that has no conversation yet', async () => {
    const host = new FakeHost();
    serve(host);
    await show(host.threadId);

    await click(radioFor(container, UNTITLED.conversationId));
    await click(buttonByText(container, '连接这个会话'));

    expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: UNTITLED.chatUrl }]);
    expect(status()).toBe('connected');
    expect(container.textContent).toContain(UNTITLED.conversationId);
  });

  it('disconnects, and offers the choice again', async () => {
    const host = connected(STARS);
    serve(host);
    await show(host.threadId);

    await click(buttonByText(container, '更换'));
    await click(buttonByText(container, '断开连接'));

    expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: null }]);
    expect(status()).toBe('unconnected');
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(document.activeElement?.getAttribute('type')).toBe('radio');
  });

  it('disconnects a revoked conversation even when nothing is authorized', async () => {
    const host = new FakeHost();
    host.bindings = { 'gpt-pro': 'https://chatgpt.com/c/conversation-gone' };
    host.candidates = [];
    serve(host);
    await show(host.threadId);

    expect(status()).toBe('revoked');
    expect(container.textContent).toContain('conversation-gone');
    expect(container.textContent).toContain('还没有已授权的会话');
    await click(buttonByText(container, '断开连接'));

    expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: null }]);
    expect(status()).toBe('unconnected');
    expect(buttonByText(container, '断开连接')).toBeUndefined();
  });

  it('disconnects while the authorized list cannot be read, and reads the list again on request', async () => {
    const host = connected(STARS);
    host.pluginPlan = ['fail'];
    serve(host);
    await show(host.threadId);

    expect(status()).toBe('connected');
    await click(buttonByText(container, '更换'));
    expect(container.textContent).toContain('暂时读不到已授权的会话');
    expect(buttonByText(container, '取消')).toBeDefined();
    await click(buttonByText(container, '断开连接'));
    expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: null }]);
    expect(status()).toBe('unconnected');

    await click(buttonByText(container, '重试'));
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it('backs out of the chooser on Esc and returns focus to 更换', async () => {
    const host = connected(STARS);
    serve(host);
    await show(host.threadId);
    await click(buttonByText(container, '更换'));

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(document.activeElement).toBe(buttonByText(container, '更换'));
    expect(host.patches()).toEqual([]);
  });

  it('says the connection did not change only when the Host refused before writing', async () => {
    const host = connected(STARS);
    host.patchPlan = [{ status: 401, body: { error: 'Authentication required', code: 'CLOUD_BINDING_AUTH_REQUIRED' } }];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);

    expect(container.textContent).toContain('没能改用这个会话：登录状态失效了，刷新页面后再试。原来的连接没有变。');
    expect(host.bindingReads()).toHaveLength(1);
    expect(radioFor(container, REVIEW.conversationId)?.checked).toBe(true);
    expect(status()).toBe('connected');

    await click(radioFor(container, UNTITLED.conversationId));
    expect(container.textContent).not.toContain('没能改用这个会话');
  });

  it('holds every other write while one is in flight', async () => {
    const host = connected(STARS);
    const answer = gate();
    host.patchPlan = [{ gate: answer.promise }];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);
    expect(buttonByText(container, '连接中…')?.disabled).toBe(true);
    expect(buttonByText(container, '断开连接')?.disabled).toBe(true);
    expect(radioFor(container, UNTITLED.conversationId)?.disabled).toBe(true);

    answer.open();
    await flush();
    expect(host.patches()).toHaveLength(1);
    expect(status()).toBe('connected');
  });
});

describe('a stored route that cannot be read as a conversation', () => {
  // astra `a7caa34d99` P2-2: a record that does not parse is still a record, and still removable.
  const arrangements: Array<[string, (host: FakeHost) => void]> = [
    [
      'nothing is authorized',
      (host) => {
        host.candidates = [];
      },
    ],
    [
      'the authorized list cannot be read',
      (host) => {
        host.pluginPlan = ['fail'];
      },
    ],
    ['conversations are authorized', () => undefined],
  ];
  it.each(arrangements)('can be disconnected when %s', async (_case, arrange) => {
    const host = new FakeHost();
    host.bindings = { 'gpt-pro': 'legacy-invalid-binding' };
    arrange(host);
    serve(host);
    await show(host.threadId);

    expect(status()).toBe('invalid');
    expect(container.textContent).toContain('连接记录无效');
    await click(buttonByText(container, '断开连接'));

    expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: null }]);
    expect(host.bindings['gpt-pro']).toBeUndefined();
    expect(status()).toBe('unconnected');
    expect(buttonByText(container, '断开连接')).toBeUndefined();
  });
});
