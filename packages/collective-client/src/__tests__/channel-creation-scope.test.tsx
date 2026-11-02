// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useCollectiveClient } from '../use-collective-client.js';
import { SESSION_KEY } from '../use-human-auth-session.js';
import { snapshot as readySnapshot } from './first-entry-fixture.js';

function projectionResponse(
  path: string,
  collectiveId: string,
  meta: NonNullable<typeof readySnapshot.meta>,
  me: NonNullable<typeof readySnapshot.me>,
) {
  const values: Record<string, unknown> = {
    '/api/meta': meta,
    '/api/auth/providers': { providers: [] },
    '/api/me': me,
    '/api/channels': { serviceInstanceId: meta.serviceInstanceId, collectiveId, channels: [] },
    '/api/events/human': { events: [] },
    '/api/participants': { participants: [] },
    '/api/members': { humans: [], cafes: [] },
    '/api/collaboration': {
      serviceInstanceId: meta.serviceInstanceId,
      collectiveId,
      works: [],
      roadmaps: [],
      votes: [],
      bindingVotes: [],
      decisions: [],
    },
    '/api/artifacts': { artifacts: [] },
  };
  const value = values[path];
  if (value === undefined) throw new Error(`Unexpected request ${path}`);
  return new Response(JSON.stringify(value), { status: 200 });
}

it('ignores a create response after the Human selects another Collective on the same Service', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.sessionStorage.clear();
  const fixtureCollective = readySnapshot.collective;
  const fixtureMeta = readySnapshot.meta;
  const fixtureMe = readySnapshot.me;
  if (!fixtureCollective || !fixtureMeta || !fixtureMe) throw new Error('Expected a ready Client fixture');
  const first = { ...fixtureCollective, collectiveId: 'col_aaaaaaaa', name: 'World A' };
  const second = { ...fixtureCollective, collectiveId: 'col_bbbbbbbb', name: 'World B' };
  const meta = { ...fixtureMeta, capabilities: { channels: 1 as const } };
  const me = { ...fixtureMe, collectives: [first, second] };
  window.history.replaceState(null, '', `/?collectiveId=${first.collectiveId}`);
  window.sessionStorage.setItem(`${SESSION_KEY}:${location.origin}`, 'fixture-session');
  let finishCreate: (response: Response) => void = () => {
    throw new Error('Channel creation did not start');
  };
  let createStarted = false;
  let blockSecondProjection = false;
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, location.origin);
      const collectiveId = url.searchParams.get('collectiveId') ?? first.collectiveId;
      if (url.pathname === '/api/channels' && init?.method === 'POST') {
        createStarted = true;
        return new Promise<Response>((resolve) => {
          finishCreate = resolve;
        });
      }
      if (blockSecondProjection && collectiveId === second.collectiveId) return new Promise<Response>(() => {});
      return projectionResponse(url.pathname, collectiveId, meta, me);
    }),
  );
  let client: ReturnType<typeof useCollectiveClient> | undefined;
  function Harness() {
    client = useCollectiveClient();
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    expect(client?.snapshot.phase).toBe('ready');
    let pending: ReturnType<NonNullable<typeof client>['createChannel']> | undefined;
    await act(async () => {
      pending = client?.createChannel('A-only-channel', 'scope-race-0001');
    });
    expect(createStarted).toBe(true);
    blockSecondProjection = true;
    await act(async () => client?.selectCollective(second.collectiveId));
    expect(client?.snapshot.collective?.collectiveId).toBe(second.collectiveId);
    let result: Awaited<NonNullable<typeof pending>>;
    await act(async () => {
      finishCreate(
        json({
          status: 'created',
          channel: {
            serviceInstanceId: meta.serviceInstanceId,
            collectiveId: first.collectiveId,
            channelId: 'A-only-channel',
            visibility: 'public',
            createdBy: { humanId: me.human.humanId, displayName: me.human.displayName },
            createdAt: '2026-10-29T00:00:00.000Z',
            revision: 1,
          },
        }),
      );
      result = await pending;
    });
    expect(result).toBeUndefined();
    expect(client?.snapshot.channels?.some((channel) => channel.collectiveId !== second.collectiveId) ?? false).toBe(
      false,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});
