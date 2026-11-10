import type { LifecycleActiveRun } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageNavigationProvider } from '@/components/thread-chat/MessageNavigationContext';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import {
  isLinkedDeliveryFailureCarrier,
  MessageDispatchAvatars,
  projectMessageDispatchAvatars,
} from '../MessageDispatchAvatars';
import { CausalReplyContinuations } from '../reply-layers/CausalReplyBody';
import { CausalReplyProvider } from '../reply-layers/CausalReplyContext';

vi.mock('../CatAvatar', () => ({
  CatAvatar: ({ catId, status, size }: { catId: string; status?: string; size?: number }) => (
    <span data-testid="cat-avatar" data-cat-id={catId} data-status={status} data-size={size} />
  ),
}));

const DISPATCHED_AT = new Date(2026, 8, 7, 13, 2, 14).getTime();

const source = (phase: 'dispatched' | 'settled', statusMessageId = 'response-1'): ChatMessage => ({
  id: 'source-1',
  from: { kind: 'external', connectorId: 'github' },
  type: 'connector',
  content: 'PR changed',
  timestamp: 100,
  lifecycle: {
    kind: 'input',
    orderKey: '100:source-1',
    dispatchRefs: [{ targetId: 'opus', phase, statusMessageId, dispatchedAt: DISPATCHED_AT }],
  },
});

const response = (
  status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted',
  inputMessageIds: readonly string[] = ['source-1'],
): ChatMessage => ({
  id: 'response-1',
  from: { kind: 'agent', catId: 'opus' },
  type: 'assistant',
  catId: 'opus',
  content: status === 'processing' ? '' : 'terminal',
  timestamp: 110,
  lifecycle: {
    kind: 'response',
    orderKey: '110:turn-1',
    invocationId: 'turn-1',
    targetId: 'opus',
    inputEntryIds: ['entry-1'],
    inputMessageIds,
    status,
    startedAt: 110,
    ...(status === 'processing' ? {} : { completedAt: 120 }),
  },
});

const activeRun: LifecycleActiveRun = {
  threadId: 'thread-1',
  targetId: 'opus',
  invocationId: 'turn-1',
  responseMessageId: 'response-1',
  inputEntryIds: ['entry-1'],
  inputMessageIds: ['source-1'],
  privateInputEntryIds: [],
  startedAt: 110,
};

describe('projectMessageDispatchAvatars', () => {
  it('projects an exact dispatchRef as delivered even before its response is visible', () => {
    expect(projectMessageDispatchAvatars(source('dispatched'), [], [])).toEqual([
      {
        targetId: 'opus',
        phase: 'delivered',
        dispatchedAt: DISPATCHED_AT,
        evidenceKey: `dispatch:opus:response-1:${DISPATCHED_AT}`,
      },
    ]);
  });

  it('blinks and links only for the exact processing response and ActiveRun', () => {
    expect(projectMessageDispatchAvatars(source('dispatched'), [response('processing')], [activeRun])).toEqual([
      {
        targetId: 'opus',
        phase: 'processing',
        dispatchedAt: DISPATCHED_AT,
        statusMessageId: 'response-1',
        evidenceKey: 'message:response-1',
      },
    ]);
  });

  it.each([
    ['user', { from: { kind: 'user', userId: 'user-1' }, type: 'user', catId: undefined }],
    ['cat', { from: { kind: 'agent', catId: 'codex' }, type: 'assistant', catId: 'codex' }],
    ['IM connector', { from: { kind: 'external', connectorId: 'weixin' }, type: 'connector', catId: undefined }],
    ['GitHub notice', { from: { kind: 'external', connectorId: 'github' }, type: 'connector', catId: undefined }],
    ['system row', { from: { kind: 'system', service: 'scheduler' }, type: 'system', catId: undefined }],
  ] as const)('uses the same exact lifecycle projection for a %s source', (_label, identity) => {
    const candidate = { ...source('settled'), ...identity } as ChatMessage;
    expect(projectMessageDispatchAvatars(candidate, [response('completed')], [])).toEqual([
      {
        targetId: 'opus',
        phase: 'settled',
        dispatchedAt: DISPATCHED_AT,
        statusMessageId: 'response-1',
        evidenceKey: 'message:response-1',
      },
    ]);
  });

  it.each([
    'completed',
    'failed',
    'canceled',
    'interrupted',
  ] as const)('keeps one outcome-neutral static avatar for a %s terminal response', (status) => {
    expect(projectMessageDispatchAvatars(source('settled'), [response(status)], [])).toEqual([
      {
        targetId: 'opus',
        phase: 'settled',
        dispatchedAt: DISPATCHED_AT,
        statusMessageId: 'response-1',
        evidenceKey: 'message:response-1',
      },
    ]);
  });

  it('projects an exact delivery failure as the linked settled surface', () => {
    const failure: ChatMessage = {
      id: 'failure-1',
      from: { kind: 'system', service: 'message_delivery' },
      type: 'system',
      content: '唤起 opus 失败',
      timestamp: 120,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: '120:failure-1',
        status: 'failed',
        sourceEntryId: 'entry-1',
        inputMessageId: 'source-1',
        requestedTargets: ['opus'],
        reason: 'invalid_explicit_target',
        createdAt: 120,
      },
    };
    expect(projectMessageDispatchAvatars(source('settled', failure.id), [failure], [])).toEqual([
      {
        targetId: 'opus',
        phase: 'settled',
        dispatchedAt: DISPATCHED_AT,
        statusMessageId: failure.id,
        evidenceKey: `message:${failure.id}`,
      },
    ]);
  });

  it('keeps wrong or incomplete response evidence delivery-only and non-clickable', () => {
    const wrongTarget = response('completed');
    if (wrongTarget.lifecycle?.kind !== 'response') throw new Error('fixture lost response lifecycle');
    wrongTarget.lifecycle = { ...wrongTarget.lifecycle, targetId: 'codex' };

    for (const timeline of [[wrongTarget], [response('completed', ['another-source'])], [response('processing')]]) {
      expect(projectMessageDispatchAvatars(source('dispatched'), timeline, [])).toEqual([
        {
          targetId: 'opus',
          phase: 'delivered',
          dispatchedAt: DISPATCHED_AT,
          evidenceKey: `dispatch:opus:response-1:${DISPATCHED_AT}`,
        },
      ]);
    }
  });

  it('fails closed on duplicate dispatch refs for the same target', () => {
    const duplicate = source('settled');
    if (duplicate.lifecycle?.kind !== 'input') throw new Error('fixture lost input lifecycle');
    duplicate.lifecycle = {
      ...duplicate.lifecycle,
      dispatchRefs: [
        {
          targetId: 'opus',
          phase: 'settled',
          statusMessageId: 'response-1',
          dispatchedAt: DISPATCHED_AT,
        },
        {
          targetId: 'opus',
          phase: 'settled',
          statusMessageId: 'response-2',
          dispatchedAt: DISPATCHED_AT + 1,
        },
      ],
    };
    expect(projectMessageDispatchAvatars(duplicate, [response('completed')], [])).toEqual([]);
  });
});

describe('isLinkedDeliveryFailureCarrier', () => {
  const failure = (requestedTargets: string[]): ChatMessage => ({
    id: 'failure-1',
    from: { kind: 'system', service: 'message-delivery' },
    type: 'system',
    content: '唤起处理成员失败',
    timestamp: 120,
    lifecycle: {
      kind: 'delivery_failure',
      orderKey: '120:failure-1',
      status: 'failed',
      sourceEntryId: 'entry-1',
      inputMessageId: 'source-1',
      requestedTargets,
      reason: 'no_available_target',
      createdAt: 120,
    },
  });

  const agentSource = (): ChatMessage => ({
    ...source('settled', 'failure-1'),
    from: { kind: 'agent', catId: 'codex' },
    type: 'assistant',
    catId: 'codex',
  });

  it('absorbs only a failure with exact settled source refs for every requested target', () => {
    expect(isLinkedDeliveryFailureCarrier(failure(['opus']), [agentSource()])).toBe(true);
    expect(isLinkedDeliveryFailureCarrier(failure(['codex']), [agentSource()])).toBe(false);
  });

  it('keeps an origin failure visible even when its source avatar has settled', () => {
    expect(isLinkedDeliveryFailureCarrier(failure(['opus']), [source('settled', 'failure-1')])).toBe(false);
  });

  it('never absorbs a targetless origin failure by vacuous truth', () => {
    expect(isLinkedDeliveryFailureCarrier(failure([]), [agentSource()])).toBe(false);
  });
});

describe('MessageDispatchAvatars', () => {
  it('keeps the exact reply readable when R is outside the loaded page and reports a bounded miss', async () => {
    const request = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/api/session')
        ? new Response(JSON.stringify({ userId: 'reference-test-owner' }))
        : new Response('{}', { status: 404 }),
    );
    vi.stubGlobal('fetch', request);
    act(() =>
      root.render(
        <CausalReplyProvider threadId="thread-1" messages={[source('settled')]}>
          <MessageDispatchAvatars
            message={source('settled')}
            timelineMessages={[]}
            activeRuns={[]}
            threadId="thread-1"
            getCatLabel={() => '宪宪'}
          />
          <CausalReplyContinuations
            inputMessageId="source-1"
            threadId="thread-1"
            getCatById={() => undefined}
            forwardingDisabled={false}
          />
        </CausalReplyProvider>,
      ),
    );
    const link = container.querySelector<HTMLButtonElement>('button[aria-label="看宪宪的回复"]');
    expect(link).not.toBeNull();
    await act(async () => link?.click());
    const historyRequests = request.mock.calls.filter(([url]) => String(url).includes('/api/messages?'));
    expect(historyRequests).toHaveLength(1);
    expect(String(historyRequests[0]?.[0])).toContain('anchorMessageId=response-1');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('消息暂不可用');
    vi.unstubAllGlobals();
  });
  let container: HTMLDivElement;
  let root: Root;

  it.each([
    'no cut',
    'changed prefix',
    'missing middle',
  ] as const)('keeps whole-R reading when precise ranges are unavailable: %s', async (reason) => {
    const input = { ...source('settled'), timestamp: 115 };
    const canonical = response('completed', reason === 'missing middle' ? ['middle', input.id] : [input.id]);
    if (reason !== 'no cut' && canonical.lifecycle?.kind === 'response') {
      canonical.lifecycle = {
        ...canonical.lifecycle,
        appendBoundaries: [
          ...(reason === 'missing middle'
            ? [{ inputMessageId: 'middle', contentOffset: 0, prefixSha256: 'e'.repeat(64) }]
            : []),
          { inputMessageId: input.id, contentOffset: 3, prefixSha256: 'e'.repeat(64) },
        ],
      };
    }
    const request = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).includes('/api/session')
              ? { userId: 'isolated-owner' }
              : { messages: [canonical], hasMore: true },
          ),
        ),
    );
    vi.stubGlobal('fetch', request);
    await act(async () =>
      root.render(
        <CausalReplyProvider threadId="thread-1" messages={[canonical, input]}>
          <MessageDispatchAvatars
            message={input}
            timelineMessages={[canonical]}
            activeRuns={[]}
            threadId="thread-1"
            getCatLabel={() => '宪宪'}
          />
          <CausalReplyContinuations
            inputMessageId={input.id}
            threadId="thread-1"
            getCatById={() => undefined}
            forwardingDisabled={false}
          />
        </CausalReplyProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="看宪宪的回复"]')?.click());
    expect(request.mock.calls.filter(([url]) => String(url).includes('/api/messages?'))).toHaveLength(1);
    expect(container.querySelector('[data-causal-read-reference="response-1"]')?.textContent).toContain('terminal');
    expect(container.querySelector('[data-causal-continuation]')).toBeNull();
  });

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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows actual delivery time and jumps only to an exact linked response', () => {
    const statusRow = document.createElement('div');
    statusRow.dataset.messageId = 'response-1';
    statusRow.scrollIntoView = vi.fn();
    document.body.appendChild(statusRow);

    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={source('settled')}
          timelineMessages={[response('completed')]}
          activeRuns={[]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });

    const item = container.querySelector('[data-dispatch-target="opus"]');
    expect(item?.getAttribute('title')).toBe('已投递 布偶猫 · 09/07 13:02:14');
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('看布偶猫的回复');
    expect(item?.textContent).toContain('布偶猫');
    expect(item?.textContent).toContain('收到，已回复');
    expect(item?.textContent).toContain('看回复');
    act(() => button?.click());
    expect(statusRow.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(statusRow.dataset.messageJumpFocus).toBe('true');
    statusRow.remove();
  });

  it('uses the clicked surface owner when another surface contains the same reply', () => {
    const firstJump = vi.fn(() => true);
    const secondJump = vi.fn(() => true);
    act(() => {
      root.render(
        <>
          {[firstJump, secondJump].map((jump, index) => (
            <MessageNavigationProvider key={index} value={jump}>
              <MessageDispatchAvatars
                message={source('settled')}
                timelineMessages={[response('completed')]}
                activeRuns={[]}
                getCatLabel={() => '布偶猫'}
              />
            </MessageNavigationProvider>
          ))}
        </>,
      );
    });
    act(() => container.querySelectorAll('button')[1]?.click());
    expect(secondJump).toHaveBeenCalledExactlyOnceWith('response-1');
    expect(firstJump).not.toHaveBeenCalled();
  });

  it.each([
    'not_accepted',
    'incomplete',
  ] as const)('shows %s from History without a Queue recovery action', (acceptance) => {
    const message = { ...source('settled'), from: { kind: 'user' as const, userId: 'owner' } };
    message.lifecycle = {
      ...message.lifecycle!,
      dispatchRefs: message.lifecycle!.dispatchRefs!.map((ref) => ({
        ...ref,
        appendAcceptance: 'pending',
        appendDelivery: { dispatchStarted: true, requiresCompletion: true },
        ...(acceptance === 'incomplete' ? { inputRead: { status: 'read' as const, at: DISPATCHED_AT + 1 } } : {}),
      })),
      appendFailures: [
        {
          targetId: 'opus',
          invocationId: 'turn-1',
          responseMessageId: 'response-1',
          reason: 'exception',
          acceptance,
          at: DISPATCHED_AT + 2,
        },
      ],
    };
    act(() =>
      root.render(
        <MessageDispatchAvatars
          message={message}
          timelineMessages={[response('completed')]}
          activeRuns={[]}
          queue={[]}
          threadId="thread-1"
          getCatLabel={() => '宪宪'}
        />,
      ),
    );
    expect(container.textContent).toContain('宪宪');
    expect(container.textContent).toContain(acceptance === 'not_accepted' ? '未并进上一轮（未接收）' : '追加未完成');
    expect(container.textContent).toContain(acceptance === 'not_accepted' ? '重新发送' : '再发一次');
    expect(container.textContent?.includes('可能重复执行')).toBe(acceptance === 'incomplete');
    expect(container.textContent).not.toContain('收到，已回复');
    expect(container.textContent).not.toContain('核对状态');
  });

  it.each([
    { kind: 'external', connectorId: 'collective' },
    { kind: 'system', service: 'scheduler' },
    { kind: 'agent', catId: 'codex' },
  ] as const)('offers checks but no owner repeat for an unknown $kind source', (from) => {
    const message = { ...source('dispatched'), from };
    message.lifecycle = {
      ...message.lifecycle!,
      appendFailures: [
        {
          targetId: 'opus',
          invocationId: 'turn-1',
          responseMessageId: 'response-1',
          reason: 'exception',
          acceptance: 'unknown',
          at: DISPATCHED_AT + 1,
          checkedAt: DISPATCHED_AT + 2,
        },
      ],
    };
    act(() =>
      root.render(
        <MessageDispatchAvatars
          message={message}
          timelineMessages={[response('processing')]}
          activeRuns={[activeRun]}
          queue={[]}
          threadId="thread-1"
          getCatLabel={() => '宪宪'}
        />,
      ),
    );
    expect(container.textContent).toContain('核对状态');
    expect(container.textContent).not.toContain('再发一次');
  });

  it('does not borrow a parent completion for a native input still waiting for its own result', () => {
    const message = { ...source('settled'), from: { kind: 'agent' as const, catId: 'codex' } };
    message.lifecycle = {
      ...message.lifecycle!,
      dispatchRefs: message.lifecycle!.dispatchRefs!.map((ref) => ({
        ...ref,
        appendAcceptance: 'written',
        appendDelivery: { dispatchStarted: true, requiresCompletion: true },
        inputRead: { status: 'read' as const, at: DISPATCHED_AT + 1 },
      })),
    };
    act(() =>
      root.render(
        <MessageDispatchAvatars
          message={message}
          timelineMessages={[response('completed')]}
          activeRuns={[]}
          queue={[]}
          threadId="thread-1"
          getCatLabel={() => '宪宪'}
        />,
      ),
    );
    expect(container.textContent).toContain('本条补充消息还未确认完成');
    expect(container.textContent).not.toContain('已回复');
    expect(container.textContent).not.toContain('再发一次');
  });

  it('keeps History check and repeat actions usable with an empty Queue until exact receipt proof', () => {
    const message = { ...source('dispatched'), from: { kind: 'user' as const, userId: 'owner' } };
    message.lifecycle = {
      ...message.lifecycle!,
      appendFailures: [
        {
          targetId: 'opus',
          invocationId: 'turn-1',
          responseMessageId: 'response-1',
          reason: 'exception',
          acceptance: 'unknown',
          at: DISPATCHED_AT + 1,
        },
      ],
    };
    const render = () =>
      act(() =>
        root.render(
          <MessageDispatchAvatars
            message={message}
            timelineMessages={[response('processing')]}
            activeRuns={[activeRun]}
            queue={[]}
            threadId="thread-1"
            getCatLabel={() => '宪宪'}
          />,
        ),
      );
    render();
    expect(container.textContent).toContain('正在核对 宪宪 收到没…');
    expect(container.textContent).not.toContain('再发一次');
    expect(container.textContent).toContain('核对状态');
    message.lifecycle = {
      ...message.lifecycle!,
      appendFailures: message.lifecycle!.appendFailures!.map((failure) => ({
        ...failure,
        checkedAt: DISPATCHED_AT + 2,
      })),
    };
    render();
    expect(container.textContent).toContain('已送出，没确认收到');
    expect(container.textContent).toContain('再发一次');
    expect(container.textContent).toContain('如果它其实收到了，会再回一遍');
    expect(container.textContent).not.toContain('收到，正在回');
    expect(container.textContent).not.toContain('没送到');
    expect(container.textContent).not.toContain('Agent Client');
    message.lifecycle = {
      ...message.lifecycle!,
      dispatchRefs: message.lifecycle!.dispatchRefs!.map((ref) => ({ ...ref, appendAcceptance: 'accepted' })),
    };
    render();
    expect(container.textContent).not.toContain('再发一次');
    expect(container.textContent).not.toContain('没确认收到');
    expect(container.textContent).not.toContain('已读');
    message.lifecycle = {
      ...message.lifecycle!,
      dispatchRefs: [
        {
          targetId: 'opus',
          phase: 'dispatched',
          statusMessageId: 'response-1',
          dispatchedAt: DISPATCHED_AT,
          inputRead: { status: 'read', at: DISPATCHED_AT + 2 },
        },
      ],
    };
    render();
    expect(container.textContent).not.toContain('待核对');
    expect(container.textContent).not.toContain('再发一次');
  });

  it.each([false, true])('shows sending while idle and queueing only behind actual work (busy=%s)', (busy) => {
    const message: ChatMessage = {
      ...source('dispatched'),
      type: 'user',
      from: { kind: 'user', userId: 'owner' },
      lifecycle: { ...source('dispatched').lifecycle!, dispatchRefs: [] },
    };
    const entry: QueueEntry = {
      id: 'pending',
      threadId: 'thread-1',
      userId: 'owner',
      messageId: message.id,
      content: message.content,
      mergedMessageIds: [],
      targetCats: ['opus'],
      status: 'queued',
      createdAt: 100,
      autoExecute: true,
      intent: 'execute',
      from: message.from!,
      priority: 'normal',
    };
    act(() =>
      root.render(
        <MessageDispatchAvatars
          message={message}
          timelineMessages={[]}
          activeRuns={busy ? [{ ...activeRun, inputMessageIds: ['older-input'] }] : []}
          queue={[entry]}
          getCatLabel={() => '宪宪'}
        />,
      ),
    );
    expect(container.textContent).toContain(busy ? '排队中' : '发送中');
    expect(container.textContent).not.toContain(busy ? '发送中' : '排队中');
  });

  it('does not count an original handoff still being checked as work ahead of an explicit repeat', () => {
    const original = source('dispatched');
    const repeated = { ...original, id: 'new-input', lifecycle: { ...original.lifecycle!, dispatchRefs: [] } };
    const base = {
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'input',
      mergedMessageIds: [],
      targetCats: ['opus'],
      status: 'queued' as const,
      createdAt: 100,
      autoExecute: true,
      intent: 'execute',
      from: original.from!,
      priority: 'normal' as const,
    };
    const queue = [
      { ...base, id: 'old-entry', messageId: original.id },
      { ...base, id: 'new-entry', messageId: repeated.id },
    ];
    act(() =>
      root.render(
        <MessageDispatchAvatars
          message={repeated}
          timelineMessages={[original, response('processing')]}
          activeRuns={[activeRun]}
          queue={queue}
          getCatLabel={() => '宪宪'}
        />,
      ),
    );
    expect(container.textContent).toContain('排队中 · 等');
    expect(container.textContent).not.toContain('前面还有');
  });

  it('uses a first input receipt when present, without treating a response as read evidence', () => {
    const initial = source('settled');
    const render = () =>
      act(() =>
        root.render(
          <MessageDispatchAvatars
            message={initial}
            timelineMessages={[response('completed')]}
            activeRuns={[]}
            getCatLabel={() => '布偶猫'}
          />,
        ),
      );
    render();
    expect(container.querySelector('[data-dispatch-target="opus"]')?.getAttribute('title')).toBe(
      '已投递 布偶猫 · 09/07 13:02:14',
    );
    if (!initial.lifecycle?.dispatchRefs) throw new Error('Expected dispatch');
    initial.lifecycle = {
      ...initial.lifecycle,
      dispatchRefs: initial.lifecycle.dispatchRefs.map((ref) => ({
        ...ref,
        inputRead: { status: 'read', at: DISPATCHED_AT + 3_000 },
      })),
    };
    render();
    expect(container.querySelector('[data-dispatch-target="opus"]')?.getAttribute('title')).toBe(
      '已读 布偶猫 · 09/07 13:02:17',
    );
  });

  it('retains known delivery but marks an unlinked reply as unverified and non-clickable', () => {
    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={source('dispatched')}
          timelineMessages={[]}
          activeRuns={[]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('收到，回复状态待核对');
    expect(container.textContent).not.toContain('已回复');
    expect(container.querySelector('[data-dispatch-target="opus"]')?.getAttribute('title')).toBe(
      '已投递 布偶猫 · 09/07 13:02:14',
    );
  });

  it.each([
    ['completed', '已回复'],
    ['failed', '回复失败'],
    ['canceled', '已取消'],
    ['interrupted', '回复中断'],
  ] as const)('shows the exact %s outcome for both initial and appended inputs', (status, expected) => {
    for (const appended of [false, true]) {
      const input = { ...source('settled'), timestamp: appended ? 115 : 100 };
      const linked = response(status, appended ? ['initial-input', input.id] : [input.id]);
      act(() =>
        root.render(
          <MessageDispatchAvatars
            message={input}
            timelineMessages={[linked]}
            activeRuns={[]}
            getCatLabel={() => '布偶猫'}
          />,
        ),
      );
      expect(container.textContent).toContain(expected);
      if (status !== 'completed') expect(container.textContent).not.toContain('已回复');
      if (appended) {
        expect(container.textContent).toContain('并进了已结束的这一轮');
        expect(container.textContent).toContain('读没读查不到');
        expect(container.textContent).not.toContain('已读');
      }
    }
  });

  it('uses animation only for processing and adds no terminal outcome badge', () => {
    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={source('settled')}
          timelineMessages={[response('failed')]}
          activeRuns={[]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });
    expect(container.querySelector('[data-testid="cat-avatar"]')?.getAttribute('data-status')).toBeNull();
    expect(container.querySelector('[data-dispatch-outcome]')).toBeNull();

    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={source('dispatched')}
          timelineMessages={[response('processing')]}
          activeRuns={[activeRun]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });
    expect(container.querySelector('[data-testid="cat-avatar"]')?.getAttribute('data-status')).toBe('streaming');
    expect(container.querySelector('[data-testid="cat-avatar"]')?.getAttribute('data-size')).toBe('16');
    expect(container.textContent).toContain('收到，正在回');
  });

  it.each([
    [
      'user source at the right bubble edge',
      { from: { kind: 'user', userId: 'user-1' }, type: 'user', catId: undefined },
      ['justify-end', 'pr-10'],
      ['justify-start', 'pl-10'],
    ],
    [
      'cat source at the left bubble edge',
      { from: { kind: 'agent', catId: 'codex' }, type: 'assistant', catId: 'codex' },
      ['justify-start', 'pl-10'],
      ['justify-end', 'pr-10'],
    ],
  ] as const)('aligns a %s', (_label, identity, expectedClasses, rejectedClasses) => {
    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={{ ...source('settled'), ...identity } as ChatMessage}
          timelineMessages={[response('completed')]}
          activeRuns={[]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });

    const avatars = container.querySelector('[data-testid="message-dispatch-avatars"]');
    expect(avatars).toBeTruthy();
    for (const className of expectedClasses) expect(avatars?.classList.contains(className)).toBe(true);
    for (const className of rejectedClasses) expect(avatars?.classList.contains(className)).toBe(false);
  });
});
