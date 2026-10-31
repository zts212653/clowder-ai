// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientSnapshot } from '../client-types.js';
import { SESSION_KEY, useHumanAuthSession } from '../use-human-auth-session.js';

const initialSnapshot: ClientSnapshot = {
  phase: 'loading',
  events: [],
  providers: [],
  connection: 'online',
  delivery: { kind: 'idle' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubBootFetch(meResponse: Response | Error) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    if (path === '/api/meta') {
      return jsonResponse(200, {
        serviceInstanceId: 'svc_aaaaaaaa',
        bootstrapNeeded: false,
        onboardingComplete: true,
        clientBuildId: 'test',
      });
    }
    if (path === '/api/auth/providers') {
      return jsonResponse(200, { providers: [{ id: 'github', ready: true }] });
    }
    if (path === '/api/me') {
      if (meResponse instanceof Error) throw meResponse;
      return meResponse;
    }
    throw new Error(`Unexpected request: ${path} ${init?.method ?? 'GET'}`);
  });
}

describe('Human session recovery', () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ClientSnapshot;

  function Harness() {
    const [current, setCurrent] = useState(initialSnapshot);
    snapshot = current;
    useHumanAuthSession(current, setCurrent);
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('keeps the saved credential when the service is temporarily unavailable', async () => {
    const sessionToken = 'still-valid-after-runtime-restart';
    const storageKey = `${SESSION_KEY}:${location.origin}`;
    sessionStorage.setItem(storageKey, sessionToken);
    const fetchMock = stubBootFetch(
      jsonResponse(503, { error: { code: 'INTERNAL', message: 'Collective 正在重新启动' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(<Harness />));

    expect(snapshot).toMatchObject({
      phase: 'unavailable',
      connection: 'offline',
      error: 'Collective 正在重新启动',
    });
    expect(sessionStorage.getItem(storageKey)).toBe(sessionToken);
    const meRequest = fetchMock.mock.calls.find(([path]) => path === '/api/me');
    expect(meRequest?.[1]?.headers).toMatchObject({ authorization: `Bearer ${sessionToken}` });
  });

  it('keeps the saved credential when the connection drops during recovery', async () => {
    const sessionToken = 'still-valid-after-network-drop';
    const storageKey = `${SESSION_KEY}:${location.origin}`;
    sessionStorage.setItem(storageKey, sessionToken);
    vi.stubGlobal('fetch', stubBootFetch(new TypeError('Failed to fetch')));

    await act(async () => root.render(<Harness />));

    expect(snapshot).toMatchObject({ phase: 'unavailable', connection: 'offline', error: 'Failed to fetch' });
    expect(sessionStorage.getItem(storageKey)).toBe(sessionToken);
  });

  it('clears the saved credential only when the service rejects the session', async () => {
    const storageKey = `${SESSION_KEY}:${location.origin}`;
    sessionStorage.setItem(storageKey, 'expired-session');
    vi.stubGlobal(
      'fetch',
      stubBootFetch(
        jsonResponse(401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'A valid human session is required' },
        }),
      ),
    );

    await act(async () => root.render(<Harness />));

    expect(snapshot).toMatchObject({ phase: 'entry', connection: 'online' });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
