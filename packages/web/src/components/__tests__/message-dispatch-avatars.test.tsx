import type { LifecycleActiveRun } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  isLinkedDeliveryFailureCarrier,
  MessageDispatchAvatars,
  projectMessageDispatchAvatars,
} from '../MessageDispatchAvatars';

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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
    expect(item?.getAttribute('title')).toBe('布偶猫 已投递 · 09/07 13:02:14');
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('布偶猫 已投递 · 09/07 13:02:14，跳转到对应回复');
    act(() => button?.click());
    expect(statusRow.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(statusRow.dataset.lineageFocus).toBe('true');
    statusRow.remove();
  });

  it('renders an unlinked delivered avatar as tooltip-only', () => {
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
    expect(container.querySelector('[data-dispatch-target="opus"]')?.getAttribute('title')).toBe(
      '布偶猫 已投递 · 09/07 13:02:14',
    );
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
    expect(container.querySelector('[data-testid="cat-avatar"]')?.getAttribute('data-size')).toBe('11');
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
