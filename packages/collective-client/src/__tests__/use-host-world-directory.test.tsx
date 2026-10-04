// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientSnapshot } from '../client-types.js';
import { useHostWorldDirectory } from '../use-host-world-directory.js';

const snapshot: ClientSnapshot = {
  phase: 'ready',
  meta: {
    serviceInstanceId: 'svc_12345678',
    bootstrapNeeded: false,
    onboardingComplete: true,
    clientBuildId: 'build-1',
  },
  me: {
    human: { humanId: 'human_12345678', displayName: 'You', createdAt: '2026-09-27T00:00:00.000Z' },
    auth: { provider: 'github', handle: 'operator' },
    collectives: [
      {
        collectiveId: 'col_12345678',
        name: 'Alpha',
        createdByHumanId: 'human_12345678',
        createdAt: '2026-09-27T00:00:00.000Z',
        role: 'steward',
      },
      {
        collectiveId: 'col_87654321',
        name: 'Invite-only room',
        createdByHumanId: 'human_87654321',
        createdAt: '2026-09-27T01:00:00.000Z',
        role: 'member',
      },
    ],
  },
  collective: {
    collectiveId: 'col_12345678',
    name: 'Alpha',
    createdByHumanId: 'human_12345678',
    createdAt: '2026-09-27T00:00:00.000Z',
    role: 'steward',
  },
  providers: [],
  events: [],
  connection: 'online',
  delivery: { kind: 'idle' },
};
const snapshotHuman = snapshot.me;
if (!snapshotHuman) throw new Error('Expected an authenticated Human fixture');

function Harness({
  currentSnapshot = snapshot,
  selectCollective,
}: {
  readonly currentSnapshot?: ClientSnapshot;
  readonly selectCollective: (collectiveId: string) => void;
}) {
  useHostWorldDirectory({ embedded: true, snapshot: currentSnapshot, selectCollective });
  return null;
}

describe('useHostWorldDirectory', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalParent: Window;
  const host = { postMessage: vi.fn() };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalParent = window.parent;
    Object.defineProperty(window, 'parent', { configurable: true, value: host });
    window.history.replaceState(null, '', '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    host.postMessage.mockReset();
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('handshakes with the exact Host and applies only a current membership selection', async () => {
    const selectCollective = vi.fn();
    await act(async () => root.render(<Harness selectCollective={selectCollective} />));
    expect(host.postMessage).toHaveBeenCalledWith(
      { type: 'collective:world-directory-ready' },
      'http://localhost:3000',
    );

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:3000',
          source: host as unknown as MessageEventSource,
          data: { type: 'collective:host-world-directory-init', bridgeId: 'bridge_12345678' },
        }),
      );
    });
    const directory = host.postMessage.mock.calls.find(
      ([message]) => message.type === 'collective:client-world-directory',
    )?.[0];
    expect(directory).toMatchObject({ state: 'ready', revision: 1, memberships: expect.any(Array) });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:3000',
          source: host as unknown as MessageEventSource,
          data: {
            type: 'collective:host-select-world',
            bridgeId: 'bridge_12345678',
            directoryRevision: 1,
            serviceInstanceId: 'svc_12345678',
            humanId: 'human_12345678',
            collectiveId: 'col_87654321',
          },
        }),
      );
    });
    expect(selectCollective).toHaveBeenCalledWith('col_87654321');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:3000',
        source: host as unknown as MessageEventSource,
        data: {
          type: 'collective:host-select-world',
          bridgeId: 'bridge_12345678',
          directoryRevision: 1,
          serviceInstanceId: 'svc_12345678',
          humanId: 'human_12345678',
          collectiveId: 'col_missing00',
        },
      }),
    );
    expect(selectCollective).toHaveBeenCalledTimes(1);
  });

  it('keeps one generation across ordinary snapshot updates and renews it when the Human changes', async () => {
    await act(async () => root.render(<Harness selectCollective={vi.fn()} />));
    expect(
      host.postMessage.mock.calls.filter(([message]) => message.type === 'collective:world-directory-ready'),
    ).toHaveLength(1);

    await act(async () =>
      root.render(<Harness currentSnapshot={{ ...snapshot, events: [] }} selectCollective={vi.fn()} />),
    );
    expect(
      host.postMessage.mock.calls.filter(([message]) => message.type === 'collective:world-directory-ready'),
    ).toHaveLength(1);

    await act(async () =>
      root.render(
        <Harness
          currentSnapshot={{
            ...snapshot,
            me: {
              ...snapshotHuman,
              human: { ...snapshotHuman.human, humanId: 'human_changed0' },
            },
          }}
          selectCollective={vi.fn()}
        />,
      ),
    );
    expect(
      host.postMessage.mock.calls.filter(([message]) => message.type === 'collective:world-directory-ready'),
    ).toHaveLength(2);
  });
});
