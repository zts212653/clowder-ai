// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectiveClientNamespace } from '../human-send-custody.js';
import { useCollectiveClient } from '../use-collective-client.js';
import { SESSION_KEY } from '../use-human-auth-session.js';
import { snapshot as ready } from './first-entry-fixture.js';
import { human } from './topic-reply.fixture.js';

let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof useCollectiveClient>;
let resourceStatus = 200;
let meStatus = 200;
let member = true;
const storageKey = `${SESSION_KEY}:${location.origin}`;
const { me: readyMe, collective, meta } = ready;
if (!readyMe || !collective || !meta) throw new Error('Expected authenticated fixture');
const alternateCollective = {
  ...collective,
  collectiveId: 'col_savedreturn',
  name: '保存频道的共同体',
};
const me = { ...readyMe, collectives: [collective, alternateCollective] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function currentHumanResponse(): Response {
  if (meStatus !== 200) return json(meStatus, { error: { message: 'authority unavailable' } });
  return json(200, { ...me, collectives: member ? me.collectives : [] });
}

function Harness() {
  client = useCollectiveClient();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  window.history.replaceState(null, '', `/?collectiveId=${collective.collectiveId}`);
  sessionStorage.setItem(storageKey, 'valid-human-session');
  resourceStatus = 200;
  meStatus = 200;
  member = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = input.split('?')[0];
      if (path === '/api/meta') return json(200, ready.meta);
      if (path === '/api/auth/providers') return json(200, { providers: [] });
      if (path === '/api/me') return currentHumanResponse();
      if (resourceStatus !== 200) return json(resourceStatus, { error: { message: 'resource denied' } });
      const data: Record<string, unknown> = {
        '/api/events/human': { events: [human] },
        '/api/participants': { participants: ready.participants },
        '/api/members': ready.members,
        '/api/collaboration': {
          serviceInstanceId: meta.serviceInstanceId,
          collectiveId: collective.collectiveId,
          works: [],
          roadmaps: [],
          votes: [],
          bindingVotes: [],
          decisions: [],
        },
        '/api/artifacts': { artifacts: [] },
      };
      if (Object.hasOwn(data, path)) return json(200, data[path]);
      throw new Error(`Unexpected request ${input}`);
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(client.snapshot.events).toHaveLength(1);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('restores the saved channel target when selecting a previously visited world', async () => {
  const namespace = collectiveClientNamespace({ ...client.snapshot, collective: alternateCollective });
  expect(namespace).toBeDefined();
  localStorage.setItem(`collective-channel:${namespace}`, 'research');
  window.history.replaceState(null, '', `/?collectiveId=${collective.collectiveId}&channelId=general`);

  await act(async () => client.selectCollective(alternateCollective.collectiveId));

  expect(client.snapshot.collective?.collectiveId).toBe(alternateCollective.collectiveId);
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('research');
});

it('keeps an unvisited world on its home instead of inventing a channel target', async () => {
  window.history.replaceState(null, '', `/?collectiveId=${collective.collectiveId}&channelId=general`);

  await act(async () => client.selectCollective(alternateCollective.collectiveId));

  expect(client.snapshot.collective?.collectiveId).toBe(alternateCollective.collectiveId);
  expect(new URL(window.location.href).searchParams.has('channelId')).toBe(false);
});

it('closes the removed membership scope while retaining the valid Human session', async () => {
  resourceStatus = 403;
  member = false;
  await act(async () => client.hostHumanSession.refresh());
  expect(client.snapshot.events).toEqual([]);
  expect(client.snapshot.participants).toBeUndefined();
  expect(client.snapshot.collaboration).toBeUndefined();
  expect(client.snapshot.collective).toBeUndefined();
  expect(client.snapshot.me?.human).toEqual(me.human);
  expect(client.snapshot).toMatchObject({ restrictedScope: { reason: 'membership_lost' } });
  expect(sessionStorage.getItem(storageKey)).toBe('valid-human-session');
  expect(client.artifacts.api).toBeUndefined();
});

it('a resource 401 cannot clear login when /api/me is temporarily unavailable', async () => {
  resourceStatus = 401;
  meStatus = 503;
  await act(async () => client.hostHumanSession.refresh());
  expect(client.snapshot.events).toEqual([]);
  expect(client.snapshot.me?.human).toEqual(me.human);
  expect(client.snapshot).toMatchObject({ restrictedScope: { reason: 'unavailable' } });
  expect(sessionStorage.getItem(storageKey)).toBe('valid-human-session');
});

it('clears an expired session only after authoritative /api/me 401 and keeps the recovery coordinates', async () => {
  resourceStatus = 401;
  meStatus = 401;
  await act(async () => client.hostHumanSession.refresh());
  expect(client.snapshot.events).toEqual([]);
  expect(client.snapshot.me).toBeUndefined();
  expect(client.snapshot).toMatchObject({
    phase: 'entry',
    restrictedScope: { reason: 'session_expired', humanId: me.human.humanId },
  });
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});

it('reopens only after a fresh successful retry, with no cached discussion between', async () => {
  resourceStatus = 403;
  await act(async () => client.hostHumanSession.refresh());
  expect(client.snapshot.events).toEqual([]);
  expect(client.snapshot).toMatchObject({ restrictedScope: { reason: 'unavailable' } });
  resourceStatus = 200;
  await act(async () => client.hostHumanSession.refresh());
  expect(client.snapshot.events).toEqual([human]);
  expect(client.snapshot).not.toHaveProperty('restrictedScope', expect.anything());
});

it('does not mistake a service 503 for membership loss or logout', async () => {
  resourceStatus = 503;
  await act(async () => client.hostHumanSession.refresh());
  expect(client.snapshot.events).toEqual([human]);
  expect(client.snapshot.restrictedScope).toBeUndefined();
  expect(client.snapshot.connection).toBe('offline');
  expect(sessionStorage.getItem(storageKey)).toBe('valid-human-session');
});

it('a superseding denial ignores an older allow already in the serialized request lane', async () => {
  const previous = globalThis.fetch;
  let release: ((response: Response) => void) | undefined;
  let intercepted = false;
  vi.stubGlobal('fetch', (input: string) => {
    if (!intercepted && input.startsWith('/api/events/human')) {
      intercepted = true;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    return previous(input);
  });
  let oldRefresh: Promise<void> | undefined;
  await act(async () => {
    oldRefresh = client.hostHumanSession.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  });
  resourceStatus = 403;
  member = false;
  const releaseOld = release;
  if (!releaseOld) throw new Error('Expected the older refresh to reach the Service');
  await act(async () => {
    const newerRefresh = client.hostHumanSession.refresh();
    releaseOld(json(200, { events: [human] }));
    await Promise.all([oldRefresh, newerRefresh]);
  });
  expect(client.snapshot.events).toEqual([]);
  expect(client.snapshot.restrictedScope?.reason).toBe('membership_lost');
});
