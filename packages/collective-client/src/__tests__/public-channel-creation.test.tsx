// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkspace } from '../CollectiveWorkspace.js';
import { CollectiveClientRequestError } from '../client-request.js';
import type { ClientSnapshot } from '../client-types.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { snapshot as baseSnapshot, participant } from './first-entry-fixture.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

function readySnapshot(role: 'steward' | 'member'): ClientSnapshot {
  const collective = baseSnapshot.collective;
  const me = baseSnapshot.me;
  if (!collective || !me) throw new Error('Expected the first-entry fixture to contain a Collective');
  const membership = { ...collective, name: '猫咖共创组', role };
  return {
    ...baseSnapshot,
    meta: {
      ...baseSnapshot.meta,
      serviceInstanceId: participant.serviceInstanceId,
      bootstrapNeeded: false,
      onboardingComplete: true,
      clientBuildId: 'public-channel-test',
      capabilities: { channels: 1 },
    },
    collective: membership,
    me: { ...me, collectives: [membership] },
    participants: [{ ...participant, channelIds: ['general', '产品方向'] }],
  };
}

function client(snapshot: ClientSnapshot, createChannel = vi.fn()) {
  return {
    snapshot,
    switchAccount: vi.fn(),
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    leaveCollective: vi.fn(),
    sendMessage: vi.fn(),
    respondWorkAccountability: vi.fn(async () => undefined),
    createChannel,
  } as unknown as ReturnType<typeof useCollectiveClient>;
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label,
  );
}

async function enterChannelName(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="频道名"]');
  if (!input) throw new Error('Expected the channel-name input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('opens the one public-channel dialog from the steward-only Channel heading action', async () => {
  await act(async () =>
    root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot('steward'))} />),
  );

  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="新建频道"]');
  expect(trigger).not.toBeNull();

  await act(async () => trigger?.click());

  const dialog = container.querySelector('dialog[aria-label="新建频道"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.hasAttribute('open')).toBe(true);
  expect(dialog?.textContent).toContain('公开：猫咖共创组的成员都能看到、都能发言');
  const input = dialog?.querySelector<HTMLInputElement>('input[aria-label="频道名"]');
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
});

it('does not render a disabled or hidden-looking creation action for ordinary members', async () => {
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot('member'))} />));

  expect(container.querySelector('button[aria-label="新建频道"]')).toBeNull();
});

it('does not advertise channel creation when an older Service has not declared the capability', async () => {
  const snapshot = readySnapshot('steward');
  if (!snapshot.meta) throw new Error('Expected Service metadata');
  const compatible: ClientSnapshot = { ...snapshot, meta: { ...snapshot.meta, capabilities: undefined } };
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(compatible)} />));

  expect(container.querySelector('button[aria-label="新建频道"]')).toBeNull();
});

it('closes the native modal on cancel and returns to the same creation trigger', async () => {
  await act(async () =>
    root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot('steward'))} />),
  );
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="新建频道"]');
  trigger?.focus();
  await act(async () => trigger?.click());
  const dialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="新建频道"]');

  await act(async () => dialog?.dispatchEvent(new Event('cancel', { cancelable: true })));

  expect(container.querySelector('dialog[aria-label="新建频道"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps one operation identity across a failed create retry, then enters the created channel', async () => {
  const created = {
    status: 'created' as const,
    channel: {
      serviceInstanceId: participant.serviceInstanceId,
      collectiveId: participant.collectiveId,
      channelId: '发布节奏',
      visibility: 'public' as const,
      createdBy: {
        humanId: participant.humanId,
        displayName: 'You',
      },
      createdAt: '2026-10-28T15:00:00.000Z',
      revision: 1,
    },
  };
  const createChannel = vi
    .fn()
    .mockRejectedValueOnce(new CollectiveClientRequestError(503, 'Service unavailable'))
    .mockResolvedValueOnce(created);
  const current = client(readySnapshot('steward'), createChannel);
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={current} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="新建频道"]')?.click());
  await enterChannelName('发布节奏');

  await act(async () => button('新建')?.click());
  expect(container.textContent).toContain('没能新建：暂时连不上猫咖共创组的服务。点「重试」，不会建出两个');
  expect(createChannel).toHaveBeenCalledTimes(1);

  await act(async () => button('重试')?.click());
  expect(createChannel).toHaveBeenCalledTimes(2);
  expect(createChannel.mock.calls[0]?.[0]).toBe('发布节奏');
  expect(createChannel.mock.calls[1]?.[0]).toBe('发布节奏');
  expect(createChannel.mock.calls[1]?.[1]).toBe(createChannel.mock.calls[0]?.[1]);
  expect(container.querySelector('dialog[aria-label="新建频道"]')).toBeNull();
  expect(container.querySelector('[aria-label="# 发布节奏"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('发布节奏');
});

it('turns an existing name into a direct channel link without issuing a create request', async () => {
  const createChannel = vi.fn();
  await act(async () =>
    root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot('steward'), createChannel)} />),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="新建频道"]')?.click());
  await enterChannelName('产品方向');

  expect(container.textContent).toContain('已经有 # 产品方向 了 · 去这个频道');
  expect(button('新建')?.disabled).toBe(true);
  await act(async () => button('去这个频道')?.click());

  expect(createChannel).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="# 产品方向"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
});

it('stops retrying when the Service reports that channel capacity is exhausted', async () => {
  const createChannel = vi
    .fn()
    .mockRejectedValue(
      new CollectiveClientRequestError(409, 'Collective channel limit was reached', 'CHANNEL_LIMIT_REACHED'),
    );
  await act(async () =>
    root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot('steward'), createChannel)} />),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="新建频道"]')?.click());
  await enterChannelName('发布节奏');

  await act(async () => button('新建')?.click());

  expect(container.querySelector('[role="alert"]')?.textContent).toContain('频道数已经达到上限');
  expect(button('重试')).toBeUndefined();
  expect(container.querySelector<HTMLInputElement>('input[aria-label="频道名"]')?.disabled).toBe(true);
  expect(createChannel).toHaveBeenCalledTimes(1);
});

it('restores an empty persisted channel with its real creator instead of treating it as an invented route', async () => {
  window.history.replaceState({}, '', '/?channelId=%E5%8F%91%E5%B8%83%E8%8A%82%E5%A5%8F');
  const snapshot: ClientSnapshot = {
    ...readySnapshot('steward'),
    channels: [
      {
        serviceInstanceId: participant.serviceInstanceId,
        collectiveId: participant.collectiveId,
        channelId: '发布节奏',
        visibility: 'public',
        createdBy: { humanId: participant.humanId, displayName: 'You' },
        createdAt: '2026-10-28T15:00:00.000Z',
        revision: 1,
      },
    ],
  };

  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(snapshot)} />));

  expect(container.querySelector('[aria-label="# 发布节奏"]')).not.toBeNull();
  expect(container.textContent).toContain('这是这个频道的开头。');
  expect(container.textContent).toContain('You 10月28日新建，猫咖共创组的成员都能看到。');
});
