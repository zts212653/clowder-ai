// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientSnapshot } from '../client-types.js';

const client = vi.hoisted(() => ({
  snapshot: {} as ClientSnapshot,
  invitationMode: 'missing' as const,
  bootstrap: vi.fn(),
  authenticate: vi.fn(),
  configureProvider: vi.fn(),
  createCollective: vi.fn(),
  sendMessage: vi.fn(),
  createInvite: vi.fn(),
  leaveCollective: vi.fn(),
  pairHost: vi.fn(),
  selectCollective: vi.fn(),
}));
vi.mock('../use-collective-client.js', () => ({ useCollectiveClient: () => client }));

import { CollectiveClient } from '../CollectiveClient.js';

describe('CollectiveClient world directory assembly', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalParent: Window;
  const host = { postMessage: vi.fn() };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalParent = window.parent;
    Object.defineProperty(window, 'parent', { configurable: true, value: host });
    window.history.replaceState(null, '', '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
    const memberships = [
      {
        collectiveId: 'col_12345678',
        name: 'Alpha',
        createdByHumanId: 'human_12345678',
        createdAt: '2026-09-27T00:00:00.000Z',
        role: 'steward' as const,
      },
      {
        collectiveId: 'col_87654321',
        name: 'Invite-only room',
        createdByHumanId: 'human_87654321',
        createdAt: '2026-09-27T01:00:00.000Z',
        role: 'member' as const,
      },
    ];
    client.snapshot = {
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
        collectives: memberships,
      },
      providers: [],
      events: [],
      connection: 'online',
      delivery: { kind: 'idle' },
    };
    client.selectCollective.mockReset();
    host.postMessage.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the Host directory bridge mounted while a multi-membership Human has not selected a world', async () => {
    await act(async () => root.render(<CollectiveClient />));
    expect(container.textContent).toContain('选择一个共同家园');
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
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collective:client-world-directory',
        state: 'ready',
        memberships: expect.arrayContaining([
          expect.objectContaining({ collectiveId: 'col_12345678' }),
          expect.objectContaining({ collectiveId: 'col_87654321' }),
        ]),
      }),
      'http://localhost:3000',
    );
  });
});
