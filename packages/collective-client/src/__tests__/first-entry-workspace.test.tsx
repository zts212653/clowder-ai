// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkspace } from '../CollectiveWorkspace.js';
import type { CollectiveEventEnvelope } from '../client-types.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { participant, snapshot } from './first-entry-fixture.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

it('waits for an exact published empty participation before telling a newly paired owner they have no cats', async () => {
  const client = {
    snapshot: { ...snapshot, participants: [] },
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    leaveCollective: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ReturnType<typeof useCollectiveClient>;
  await act(async () => root.render(<CollectiveWorkspace embedded client={client} />));
  const bring = [...container.querySelectorAll('button')].find((button) => button.textContent === '带猫进来');
  if (!bring) throw new Error('Expected the first entry action');
  await act(async () => bring.click());
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          authorityStatus: 'connected',
        },
      }),
    );
  });
  expect(container.textContent).toContain('正在带入伙伴');
  expect(container.textContent).not.toContain('还没有可参与的伙伴');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-participation-ready',
          bridgeId: 'bridge_foreign1',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          participationRevision: 1,
          catCount: 0,
        },
      }),
    );
  });
  expect(container.textContent).toContain('正在带入伙伴');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-participation-ready',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          participationRevision: 1,
          catCount: 0,
        },
      }),
    );
  });
  expect(container.textContent).toContain('这台 Café 还没有可参与的伙伴');
  expect(container.textContent).toContain('去我的 Café 登记');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-participation-ready',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          participationRevision: 2,
          catCount: 1,
        },
      }),
    );
  });
  expect(container.textContent).toContain('正在带入伙伴');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-participation-ready',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          participationRevision: 1,
          catCount: 0,
        },
      }),
    );
  });
  expect(container.textContent).toContain('正在带入伙伴');
  await act(async () => root.render(<CollectiveWorkspace embedded client={{ ...client, snapshot }} />));
  expect(container.querySelector('[aria-label="入场演示"]')).not.toBeNull();
});

it('plays the guide locally, leaves Service events untouched, and hands the real composer a named cat', async () => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const client = {
    snapshot,
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    leaveCollective: vi.fn(),
    sendMessage,
  } as unknown as ReturnType<typeof useCollectiveClient>;
  await act(async () => root.render(<CollectiveWorkspace embedded client={client} />));
  expect(container.textContent).toContain('先把你的猫带进来');
  await act(async () => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '带猫进来');
    if (!button) throw new Error('Expected the first entry action');
    button.click();
  });
  expect(client.pairHost).toHaveBeenCalledTimes(1);

  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          authorityStatus: 'connected',
        },
      }),
    );
  });
  expect(container.querySelector('[aria-label="入场演示"]')).not.toBeNull();
  expect(container.textContent).toContain('缅因猫（砚砚）');
  expect(sendMessage).not.toHaveBeenCalled();
  expect(snapshot.events).toHaveLength(0);

  const skip = [...container.querySelectorAll('[aria-label="入场演示"] button')].find(
    (button) => button.textContent === '跳过',
  );
  expect(skip).not.toBeUndefined();
  await act(async () => (skip as HTMLButtonElement).click());
  expect(container.querySelectorAll('[data-demo]')).toHaveLength(0);
  expect(container.textContent).toContain('#general 是公开频道');
  expect(container.textContent).toContain('@缅因猫（砚砚）');
  expect(sendMessage).not.toHaveBeenCalled();
  expect(snapshot.events).toHaveLength(0);

  await act(async () => {
    const input = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '帮我检查第一次协作');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(sendMessage).toHaveBeenCalledWith('帮我检查第一次协作', {
    location: { channelId: 'general' },
    recipient: {
      kind: 'agent',
      connectionId: participant.connectionId,
      humanId: participant.humanId,
      agentId: participant.catId,
      participationRevision: participant.participationRevision,
    },
  });

  const request: CollectiveEventEnvelope = {
    serviceInstanceId: participant.serviceInstanceId,
    collectiveId: participant.collectiveId,
    eventId: 'evt_guide_request',
    clientEventId: 'sent-by-human',
    sequence: 1,
    actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
    target: { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general' },
    recipient: {
      kind: 'agent',
      connectionId: participant.connectionId,
      humanId: participant.humanId,
      agentId: participant.catId,
      participationRevision: participant.participationRevision,
    },
    body: '帮我检查第一次协作',
    acceptedAt: '2026-09-25T00:00:01.000Z',
  };
  const reply: CollectiveEventEnvelope = {
    ...request,
    eventId: 'evt_guide_reply',
    clientEventId: 'real-agent-reply',
    sequence: 2,
    actor: {
      kind: 'agent',
      human: { humanId: participant.humanId, displayName: 'You' },
      agent: { agentId: participant.catId, displayName: participant.displayName },
      provenance: {
        connectionId: participant.connectionId,
        endpointId: participant.endpointId,
        endpointLabel: participant.endpointLabel,
        catId: participant.catId,
        sessionRef: 'real-session',
      },
    },
    target: { kind: 'message', eventId: request.eventId },
    location: { channelId: 'general', rootEventId: request.eventId },
    recipient: { kind: 'human', humanId: participant.humanId },
    replyToEventId: request.eventId,
    body: '收到，我来检查。',
    acceptedAt: '2026-09-25T00:00:02.000Z',
  };
  await act(async () =>
    root.render(<CollectiveWorkspace embedded client={{ ...client, snapshot: { ...snapshot, events: [request] } }} />),
  );
  expect(container.textContent).not.toContain('随时增减伙伴');
  await act(async () =>
    root.render(
      <CollectiveWorkspace embedded client={{ ...client, snapshot: { ...snapshot, events: [request, reply] } }} />,
    ),
  );
  expect(container.textContent).toContain('随时增减伙伴');
  await act(async () => {
    const input = container.querySelector('textarea');
    if (!input) throw new Error('Expected the real composer');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Expected a native textarea setter');
    setter.call(input, '留在频道里的草稿');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(
    [...container.querySelectorAll('button')].filter((button) => button.textContent === '再看一遍演示'),
  ).toHaveLength(1);
  const replay = [...container.querySelectorAll('button')].find((button) => button.textContent === '再看一遍演示');
  if (!replay) throw new Error('Expected a replay control');
  await act(async () => replay.click());
  expect(container.querySelector('[aria-label="入场演示"]')).not.toBeNull();
  const skipReplay = [...container.querySelectorAll('[aria-label="入场演示"] button')].find(
    (button) => button.textContent === '跳过',
  );
  if (!skipReplay) throw new Error('Expected to skip the replay');
  await act(async () => (skipReplay as HTMLButtonElement).click());
  expect(container.querySelector('textarea')?.value).toBe('留在频道里的草稿');
  expect(container.querySelectorAll('[data-demo]')).toHaveLength(0);

  await act(async () =>
    root.render(
      <CollectiveWorkspace
        key="refreshed"
        embedded
        client={{ ...client, snapshot: { ...snapshot, events: [request, reply] } }}
      />,
    ),
  );
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_refreshed',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          authorityStatus: 'connected',
        },
      }),
    );
  });
  expect(container.querySelector('[aria-label="入场演示"]')).toBeNull();
  expect(container.textContent).toContain('再看一遍演示');
});
