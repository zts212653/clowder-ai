// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientSnapshot } from '../client-types.js';
import { HUMAN_AUTH_WINDOW_NAME } from '../human-auth-flow.js';
import { SESSION_KEY, useHumanAuthSession } from '../use-human-auth-session.js';

const meta = {
  serviceInstanceId: 'service-test',
  bootstrapNeeded: false,
  onboardingComplete: false,
  clientBuildId: 'test',
};
let root: Root;
let container: HTMLDivElement;
let session: ReturnType<typeof useHumanAuthSession>;
let current: ClientSnapshot;

function Harness() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>({
    phase: 'loading',
    events: [],
    providers: [],
    connection: 'online',
    delivery: { kind: 'idle' },
  });
  current = snapshot;
  session = useHumanAuthSession(snapshot, setSnapshot);
  return (
    <div>
      {snapshot.phase}: {snapshot.error}
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  history.replaceState(null, '', '/');
  window.name = '';
  Object.defineProperty(window, 'opener', { value: null, configurable: true, writable: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('returns from invitation authentication into the invited Collective, even for a person with several memberships', async () => {
  const inviteTarget = 'col_12345678';
  const otherTarget = 'col_87654321';
  history.replaceState(null, '', '/?authCompleted=1#invite=example');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/meta') return new Response(JSON.stringify({ ...meta, bootstrapNeeded: false }));
      if (path === '/api/auth/providers')
        return new Response(JSON.stringify({ providers: [{ id: 'github', ready: true }] }));
      if (path === '/api/auth/completions/exchange') {
        return new Response(JSON.stringify({ sessionToken: 'verified-session-token', collectiveId: inviteTarget }));
      }
      if (path === '/api/me')
        return new Response(
          JSON.stringify({
            human: { humanId: 'human_12345678', displayName: 'Friend', createdAt: '2026-08-29T00:00:00.000Z' },
            auth: { provider: 'github', handle: 'friend' },
            collectives: [
              {
                collectiveId: otherTarget,
                name: 'Elsewhere',
                createdByHumanId: 'human_other',
                createdAt: '2026-08-29T00:00:00.000Z',
                role: 'member',
              },
              {
                collectiveId: inviteTarget,
                name: 'Meow-Club',
                createdByHumanId: 'human_owner',
                createdAt: '2026-08-29T00:00:00.000Z',
                role: 'member',
              },
            ],
          }),
        );
      throw new Error(`Unexpected request: ${path}`);
    }),
  );

  await act(async () => root.render(<Harness />));
  expect(current.collective).toMatchObject({ collectiveId: inviteTarget, name: 'Meow-Club' });
  expect(location.search).toBe(`?collectiveId=${inviteTarget}&channelId=general`);
  expect(location.hash).toBe('');
});

it('carries the verified invite target from the authenticated popup to its opener', async () => {
  const inviteTarget = 'col_12345678';
  const otherTarget = 'col_87654321';
  history.replaceState(null, '', '/#invite=example');
  const popup = { close: vi.fn(), location: { assign: vi.fn() } };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/meta') return new Response(JSON.stringify({ ...meta, bootstrapNeeded: false }));
      if (path === '/api/auth/providers')
        return new Response(JSON.stringify({ providers: [{ id: 'github', ready: true }] }));
      if (path === '/api/auth/github/begin')
        return new Response(JSON.stringify({ authorizationUrl: 'https://github.com/login/oauth/authorize' }));
      if (path === '/api/me')
        return new Response(
          JSON.stringify({
            human: { humanId: 'human_12345678', displayName: 'Friend', createdAt: '2026-08-29T00:00:00.000Z' },
            auth: { provider: 'github', handle: 'friend' },
            collectives: [
              {
                collectiveId: otherTarget,
                name: 'Elsewhere',
                createdByHumanId: 'human_other',
                createdAt: '2026-08-29T00:00:00.000Z',
                role: 'member',
              },
              {
                collectiveId: inviteTarget,
                name: 'Meow-Club',
                createdByHumanId: 'human_owner',
                createdAt: '2026-08-29T00:00:00.000Z',
                role: 'member',
              },
            ],
          }),
        );
      throw new Error(`Unexpected request: ${path}`);
    }),
  );

  await act(async () => root.render(<Harness />));
  await act(async () => session.authenticate());
  const completion = new MessageEvent('message', {
    origin: location.origin,
    data: {
      type: 'collective:human-auth-completion',
      serviceUrl: location.origin,
      sessionToken: 'verified-session-token',
      collectiveId: inviteTarget,
    },
  });
  Object.defineProperty(completion, 'source', { value: popup });
  await act(async () => {
    window.dispatchEvent(completion);
  });
  const compatibleCompletion = new MessageEvent('message', {
    origin: location.origin,
    data: {
      type: 'collective:human-auth-completion',
      serviceUrl: location.origin,
      sessionToken: 'verified-session-token',
    },
  });
  Object.defineProperty(compatibleCompletion, 'source', { value: popup });
  await act(async () => {
    window.dispatchEvent(compatibleCompletion);
  });
  expect(current.collective).toMatchObject({ collectiveId: inviteTarget, name: 'Meow-Club' });
  expect(location.search).toBe(`?collectiveId=${inviteTarget}&channelId=general`);
  expect(location.hash).toBe('');
});

it('sends the Service completion target from the actual popup without exposing a completion credential', async () => {
  const inviteTarget = 'col_12345678';
  const opener = { postMessage: vi.fn() };
  window.name = HUMAN_AUTH_WINDOW_NAME;
  Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true });
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
  history.replaceState(null, '', '/?authCompleted=1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/meta') return new Response(JSON.stringify({ ...meta, bootstrapNeeded: false }));
      if (path === '/api/auth/providers')
        return new Response(JSON.stringify({ providers: [{ id: 'github', ready: true }] }));
      if (path === '/api/auth/completions/exchange')
        return new Response(
          JSON.stringify({
            sessionToken: 'verified-session-token',
            collectiveId: inviteTarget,
          }),
        );
      throw new Error(`Unexpected request: ${path}`);
    }),
  );

  await act(async () => root.render(<Harness />));
  expect(opener.postMessage).toHaveBeenCalledWith(
    {
      type: 'collective:human-auth-completion',
      serviceUrl: location.origin,
      sessionToken: 'verified-session-token',
      collectiveId: inviteTarget,
    },
    location.origin,
  );
  expect(opener.postMessage).toHaveBeenCalledWith(
    {
      type: 'collective:human-auth-completion',
      serviceUrl: location.origin,
      sessionToken: 'verified-session-token',
    },
    location.origin,
  );
});

it('does not select or retain a session for a target absent from the authenticated membership list', async () => {
  history.replaceState(null, '', '/?authCompleted=1#invite=example');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/meta') return new Response(JSON.stringify({ ...meta, bootstrapNeeded: false }));
      if (path === '/api/auth/providers')
        return new Response(JSON.stringify({ providers: [{ id: 'github', ready: true }] }));
      if (path === '/api/auth/completions/exchange')
        return new Response(
          JSON.stringify({
            sessionToken: 'verified-session-token',
            collectiveId: 'col_12345678',
          }),
        );
      if (path === '/api/me')
        return new Response(
          JSON.stringify({
            human: { humanId: 'human_12345678', displayName: 'Friend', createdAt: '2026-08-29T00:00:00.000Z' },
            auth: { provider: 'github', handle: 'friend' },
            collectives: [],
          }),
        );
      throw new Error(`Unexpected request: ${path}`);
    }),
  );

  await act(async () => root.render(<Harness />));
  expect(current).toMatchObject({ phase: 'entry', error: '邀请的共同体暂时不可用，请联系邀请人。' });
  expect(current.collective).toBeUndefined();
  expect(sessionStorage.getItem(`${SESSION_KEY}:${location.origin}`)).toBeNull();
  expect(new URLSearchParams(location.search).has('collectiveId')).toBe(false);
});

it('resumes the invited Collective after a temporary profile read failure and reload', async () => {
  history.replaceState(null, '', '/?authCompleted=1#invite=example');
  let available = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/meta') return new Response(JSON.stringify(meta));
      if (path === '/api/auth/providers') return new Response(JSON.stringify({ providers: [] }));
      if (path === '/api/auth/completions/exchange') {
        return new Response(JSON.stringify({ sessionToken: 'verified-session-token', collectiveId: 'col_12345678' }));
      }
      if (path === '/api/me')
        return available
          ? new Response(
              JSON.stringify({
                human: { humanId: 'human_12345678', displayName: 'Friend', createdAt: '2026-08-29T00:00:00.000Z' },
                auth: { provider: 'github', handle: 'friend' },
                collectives: [
                  { collectiveId: 'col_87654321', name: 'Elsewhere', role: 'member' },
                  { collectiveId: 'col_12345678', name: 'Meow-Club', role: 'member' },
                ],
              }),
            )
          : new Response(JSON.stringify({ error: { message: 'temporarily offline' } }), { status: 503 });
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  await act(async () => root.render(<Harness />));
  expect(current.phase).toBe('unavailable');
  expect(sessionStorage.getItem(`${SESSION_KEY}:${location.origin}`)).toBe('verified-session-token');
  expect(new URLSearchParams(location.search).has('authCompleted')).toBe(false);
  expect(new URLSearchParams(location.search).get('collectiveId')).toBe('col_12345678');
  expect(location.hash).toBe('');
  available = true;
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  expect(current.collective).toMatchObject({ collectiveId: 'col_12345678', name: 'Meow-Club' });
});
