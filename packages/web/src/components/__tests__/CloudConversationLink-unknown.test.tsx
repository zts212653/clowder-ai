import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

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

/** F202 h3c-1: a write whose outcome the panel cannot know is settled only by reading the route back. */

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

describe('a write whose outcome is unknown', () => {
  it.each([
    ['a 409 with only an error message', { status: 409, body: { error: 'conflict' } }],
    ['a 400 without a refusal code', { status: 400, body: { error: 'Invalid request body' } }],
    [
      'a 5xx, even one naming a refusal code',
      { status: 503, body: { error: 'down', code: 'CLOUD_BINDING_NOT_OWNER' } },
    ],
  ])('treats %s as an unknown outcome and reads the route back', async (_case, answer) => {
    const host = connected(STARS);
    host.patchPlan = [answer];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);

    expect(host.bindingReads()).toHaveLength(2);
    expect(host.bindingReads()[1]?.options).toEqual({ afterCurrentGet: true });
    expect(container.textContent).not.toContain('原来的连接没有变');
    // This Host never applied it, and the read-back says as much — without claiming it never will.
    expect(status()).toBe('connected');
    expect(container.textContent).toContain('没能确认更换成功。现在显示的是重新读取到的连接，可以再试一次。');
  });

  it('lands on the new conversation when the write committed but its answer was lost', async () => {
    const host = connected(STARS);
    const readBack = gate();
    host.patchPlan = ['lost'];
    host.readPlan = ['ok', { gate: readBack.promise }];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);

    expect(status()).toBe('confirming');
    expect(container.textContent).toContain('确认中…');
    expect(container.textContent).toContain('暂时无法确认是否更换成功，正在重新读取连接…');
    expect(container.textContent).not.toContain('已连接当前对话');
    expect(buttonByText(container, '改用这个会话')?.disabled).toBe(true);
    expect(buttonByText(container, '断开连接')?.disabled).toBe(true);
    expect(radioFor(container, REVIEW.conversationId)?.checked).toBe(true);
    expect(radioFor(container, REVIEW.conversationId)?.disabled).toBe(true);

    readBack.open();
    await flush();

    expect(status()).toBe('connected');
    expect(container.textContent).toContain(REVIEW.displayTitle);
    expect(container.textContent).not.toContain(STARS.displayTitle);
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(document.activeElement).toBe(buttonByText(container, '更换'));
  });

  it('stays unknown, and writes nothing, when the read-back fails too; reading again settles it', async () => {
    const host = connected(STARS);
    host.patchPlan = ['lost'];
    host.readPlan = ['ok', 'fail'];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);

    expect(status()).toBe('unknown');
    expect(container.textContent).toContain('状态未知');
    expect(container.textContent).toContain('无法确认是否更换成功，也暂时读不到当前连接。');
    expect(container.textContent).not.toContain('已连接');
    expect(buttonByText(container, '改用这个会话')?.disabled).toBe(true);
    expect(buttonByText(container, '断开连接')?.disabled).toBe(true);
    expect(host.patches()).toHaveLength(1);

    await click(buttonByText(container, '重新读取'));

    expect(host.bindingReads()).toHaveLength(3);
    expect(status()).toBe('connected');
    expect(container.textContent).toContain(REVIEW.displayTitle);
    expect(container.querySelector('input[type="radio"]')).toBeNull();
  });

  it('settles a disconnect of unknown outcome on the read-back', async () => {
    const host = connected(STARS);
    const readBack = gate();
    host.patchPlan = ['lost'];
    host.readPlan = ['ok', { gate: readBack.promise }];
    serve(host);
    await show(host.threadId);

    await click(buttonByText(container, '更换'));
    await click(buttonByText(container, '断开连接'));
    expect(status()).toBe('confirming');
    expect(container.textContent).toContain('暂时无法确认是否已断开，正在重新读取连接…');

    readBack.open();
    await flush();

    expect(host.bindings).toEqual({});
    expect(status()).toBe('unconnected');
    expect(container.textContent).not.toContain('暂时无法确认');
  });

  it('keeps the choice when the read-back does not show the change, so it can be tried again', async () => {
    const host = connected(STARS);
    host.patchPlan = ['unapplied-lost'];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);

    expect(status()).toBe('connected');
    expect(container.textContent).toContain('没能确认更换成功');
    expect(container.textContent).toContain('已连接当前对话');
    expect(radioFor(container, REVIEW.conversationId)?.checked).toBe(true);

    await click(buttonByText(container, '改用这个会话'));
    expect(container.textContent).toContain(REVIEW.displayTitle);
    expect(container.querySelector('input[type="radio"]')).toBeNull();
  });

  it('shows the conversation a write answered with, when another write already replaced its own', async () => {
    const host = connected(STARS);
    host.patchPlan = [{ status: 200, body: { bindings: { 'gpt-pro': UNTITLED.chatUrl } } }];
    serve(host);
    await show(host.threadId);

    await changeTo(REVIEW);

    expect(status()).toBe('connected');
    expect(container.textContent).toContain('没能确认更换成功');
    expect(radioFor(container, UNTITLED.conversationId)?.closest('label')?.textContent).toContain('已连接当前对话');
    expect(radioFor(container, REVIEW.conversationId)?.checked).toBe(true);
  });
});
