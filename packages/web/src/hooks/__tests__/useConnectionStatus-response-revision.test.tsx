// @vitest-environment jsdom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 2026-11-05: an already-open page kept running the previous frontend for 21 minutes
// after a runtime deploy. The reload gate only learned the new revision from a 2.5s
// /api/health probe, which kept timing out while the backend was overloaded, even
// though ordinary API responses were still completing.
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION', OLD);
  vi.stubEnv('NEXT_PUBLIC_CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED', '1');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('location', { hostname: 'localhost', port: '3001', protocol: 'http:' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Served = { revision: string | null; headers?: Record<string, string> };

/**
 * `/api/session` answers with `session`; every other API request takes the next entry of
 * `responses` (no revision once the list is exhausted).
 */
function serve({ session = { revision: null }, responses = [] }: { session?: Served; responses?: Served[] }) {
  const queue = [...responses];
  const respond = ({ revision, headers = {} }: Served, body: unknown) =>
    Response.json(body, {
      headers: { ...headers, ...(revision ? { 'x-clowder-deployment-revision': revision } : {}) },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith('/api/session')) return respond(session, { csrfToken: 'fixture-csrf' });
      if (path.endsWith('/api/diagnostics/connection')) return new Response(null, { status: 204 });
      return respond(queue.shift() ?? { revision: null }, {});
    }),
  );
}

async function mountGate(): Promise<{
  apiFetch: (path: string) => Promise<Response>;
  refreshApiSession: () => Promise<void>;
  text: () => string;
  root: Root;
}> {
  const { useConnectionStatus } = await import('../useConnectionStatus');
  const { apiFetch, refreshApiSession } = await import('@/utils/api-client');
  const container = document.createElement('div');
  function Gate() {
    const status = useConnectionStatus(true);
    const state = status.updateRequired ? 'update-required' : status.forwardingBlocked ? 'unverified' : 'verified';
    return <output>{state}</output>;
  }
  const root = createRoot(container);
  await act(async () => root.render(<Gate />));
  return { apiFetch, refreshApiSession, text: () => container.textContent ?? '', root };
}

async function step(action: () => Promise<unknown>) {
  await act(async () => {
    await action();
  });
}

it('raises the reload gate from the first API response that carries a newer runtime revision', async () => {
  serve({ responses: [{ revision: NEW }] });
  const gate = await mountGate();
  try {
    expect(gate.text()).toBe('unverified');
    await step(() => gate.apiFetch('/api/threads'));
    expect(gate.text()).toBe('update-required');
  } finally {
    act(() => gate.root.unmount());
  }
});

it('verifies from a matching response revision and never downgrades on a response without one', async () => {
  serve({ responses: [{ revision: OLD }, { revision: null }] });
  const gate = await mountGate();
  try {
    await step(() => gate.apiFetch('/api/threads'));
    expect(gate.text()).toBe('verified');
    await step(() => gate.apiFetch('/api/cats'));
    expect(gate.text()).toBe('verified');
  } finally {
    act(() => gate.root.unmount());
  }
});

it('ignores a revision the browser may have replayed from its HTTP cache', async () => {
  // Review R1 P1: raw workspace files are served `private, max-age=60`. A copy of an image
  // cached under the other deployment replays that deployment's header on this page.
  serve({
    responses: [
      { revision: OLD },
      { revision: NEW, headers: { 'cache-control': 'private, max-age=60' } },
      { revision: NEW, headers: { 'cache-control': 'public, immutable' } },
      { revision: NEW, headers: { 'last-modified': 'Wed, 04 Nov 2026 14:41:00 GMT' } },
    ],
  });
  const gate = await mountGate();
  try {
    await step(() => gate.apiFetch('/api/threads'));
    expect(gate.text()).toBe('verified');
    for (const path of ['/api/workspace/file/raw', '/api/asset', '/api/document']) {
      await step(() => gate.apiFetch(path));
      expect(gate.text(), path).toBe('verified');
    }
  } finally {
    act(() => gate.root.unmount());
  }
});

it('still counts a response that must be revalidated before any reuse', async () => {
  serve({ responses: [{ revision: NEW, headers: { 'cache-control': 'no-cache', 'last-modified': 'x' } }] });
  const gate = await mountGate();
  try {
    await step(() => gate.apiFetch('/api/threads'));
    expect(gate.text()).toBe('update-required');
  } finally {
    act(() => gate.root.unmount());
  }
});

it('treats the unknown sentinel as no observation, also on a revalidated cached copy', async () => {
  // Review R2 P1: the server publishes `unknown` instead of absence so a 304 overwrites a cached
  // revision; the browser then hands over the cached body carrying the merged sentinel.
  serve({
    responses: [
      { revision: 'unknown', headers: { 'cache-control': 'no-cache' } },
      { revision: OLD },
      { revision: 'unknown', headers: { 'cache-control': 'no-cache' } },
    ],
  });
  const gate = await mountGate();
  try {
    await step(() => gate.apiFetch('/api/threads?view=sidebar'));
    expect(gate.text()).toBe('unverified');
    await step(() => gate.apiFetch('/api/threads'));
    expect(gate.text()).toBe('verified');
    await step(() => gate.apiFetch('/api/threads?view=sidebar'));
    expect(gate.text()).toBe('verified');
  } finally {
    act(() => gate.root.unmount());
  }
});

it('learns a newer revision from the session bootstrap response itself', async () => {
  // Review R1 P2: the session exchange bypassed the observation point.
  serve({ session: { revision: NEW }, responses: [{ revision: null }] });
  const gate = await mountGate();
  try {
    await step(() => gate.apiFetch('/api/threads'));
    expect(gate.text()).toBe('update-required');
  } finally {
    act(() => gate.root.unmount());
  }
});

it('learns a newer revision from the session refresh a socket reconnect performs', async () => {
  // After a restart the socket reconnects first and refreshes the session: often the first
  // response the new runtime manages to deliver.
  serve({ session: { revision: NEW } });
  const gate = await mountGate();
  try {
    expect(gate.text()).toBe('unverified');
    await step(() => gate.refreshApiSession());
    expect(gate.text()).toBe('update-required');
  } finally {
    act(() => gate.root.unmount());
  }
});
