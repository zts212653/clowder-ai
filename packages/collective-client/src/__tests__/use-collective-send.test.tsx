// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import type { ClientSnapshot } from '../client-types.js';
import { collectiveClientNamespace } from '../human-send-custody.js';
import { useCollectiveSend } from '../use-collective-send.js';

const ready: ClientSnapshot = {
  phase: 'ready',
  meta: {
    serviceInstanceId: 'svc_aaaaaaaa',
    bootstrapNeeded: false,
    onboardingComplete: true,
    clientBuildId: 'test',
  },
  me: {
    human: { humanId: 'human_aaaaaaaa', displayName: 'You', createdAt: '2026-10-12T00:00:00.000Z' },
    auth: { provider: 'github', handle: 'operator' },
    collectives: [],
  },
  collective: {
    collectiveId: 'col_aaaaaaaa',
    name: '猫咖共创组',
    createdByHumanId: 'human_aaaaaaaa',
    createdAt: '2026-10-12T00:00:00.000Z',
    role: 'steward',
  },
  providers: [],
  events: [],
  connection: 'online',
  delivery: { kind: 'idle' },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows only the in-flight state, then becomes silent after a confirmed send', async () => {
  let finish: (() => void) | undefined;
  const request: ClientRequest = <Result,>() =>
    new Promise<Result>((resolve) => {
      finish = () => resolve(undefined as Result);
    });
  const currentNamespace = { current: collectiveClientNamespace(ready) };
  let send: ReturnType<typeof useCollectiveSend> | undefined;
  function Harness() {
    const [snapshot, setSnapshot] = useState(ready);
    send = useCollectiveSend({
      snapshot,
      setSnapshot,
      currentNamespace,
      request,
      refresh: vi.fn(async () => undefined),
    });
    return (
      <output data-kind={snapshot.delivery.kind}>{'label' in snapshot.delivery ? snapshot.delivery.label : ''}</output>
    );
  }

  await act(async () => root.render(<Harness />));
  let operation: Promise<void> | undefined;
  await act(async () => {
    operation = send?.('一起把这件事做完。', { location: { channelId: 'general' } });
  });
  expect(container.querySelector('output')?.dataset.kind).toBe('requesting');
  expect(container.textContent).toBe('正在发送…');

  await act(async () => {
    finish?.();
    await operation;
  });
  expect(container.querySelector('output')?.dataset.kind).toBe('idle');
  expect(container.textContent).toBe('');
});

it('keeps a short retryable failure in the composer', async () => {
  const request: ClientRequest = () => Promise.reject(new Error('offline'));
  const currentNamespace = { current: collectiveClientNamespace(ready) };
  let send: ReturnType<typeof useCollectiveSend> | undefined;
  function Harness() {
    const [snapshot, setSnapshot] = useState(ready);
    send = useCollectiveSend({
      snapshot,
      setSnapshot,
      currentNamespace,
      request,
      refresh: vi.fn(async () => undefined),
    });
    return (
      <output data-kind={snapshot.delivery.kind}>{'label' in snapshot.delivery ? snapshot.delivery.label : ''}</output>
    );
  }

  await act(async () => root.render(<Harness />));
  await act(async () => {
    await expect(send?.('再试一次。', { location: { channelId: 'general' } })).rejects.toThrow('offline');
  });
  expect(container.querySelector('output')?.dataset.kind).toBe('failed');
  expect(container.textContent).toBe('没发出去 · 重试');
});
