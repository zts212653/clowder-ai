import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], getCatById: () => undefined }) }));

import { resetConciergeDesktopObservation, useConciergeDesktopStore } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergeHost } from '../ConciergeHost';
import { ConciergeRailToggle } from '../ConciergeRailToggle';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState({}, '', '/');
  resetConciergeDesktopObservation();
  useConciergeStore.setState({
    configLoaded: false,
    configLoading: false,
    configFailed: false,
    enabled: true,
    muted: true,
    surfaceState: 'collapsed',
    threadId: null,
    threadIdLoaded: false,
    threadIdLoading: false,
  });
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/concierge/config'
            ? {
                config: {
                  enabled: true,
                  muted: false,
                  displayName: '猫猫球',
                  skin: 'ragdoll-v1',
                  dutyCatProfileId: null,
                  ballSize: 72,
                  behaviorEnabled: true,
                },
              }
            : url === '/api/concierge/thread'
              ? { threadId: 'companion-original' }
              : { presence: null, desktopLost: false },
        ),
        { status: 200 },
      ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetConciergeDesktopObservation();
  vi.restoreAllMocks();
});

it('keeps the webpage free of floating chrome before and after desktop loss', async () => {
  useConciergeStore.setState({ muted: false });
  await act(async () => root.render(<ConciergeHost />));
  expect(container.querySelector('[data-testid="concierge-ball-wrapper"]')).toBeNull();
  act(() =>
    useConciergeDesktopStore.setState({ available: false, visible: false, desktopLost: true, noticeVisible: true }),
  );
  expect(container.querySelector('[data-testid="concierge-desktop-fallback"]')).toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps the existing rail entry reachable while the companion preference is disabled', async () => {
  useConciergeStore.setState({ configLoaded: true, enabled: false });
  await act(async () => root.render(<ConciergeRailToggle />));
  expect(container.querySelector('[data-testid="concierge-rail-toggle"]')).not.toBeNull();
});

it('shows an observed available desktop without creating a conversation or changing preferences', async () => {
  useConciergeStore.setState({ configLoaded: true });
  useConciergeDesktopStore.setState({ available: true });
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ presence: { state: 'visible', maxAgeMs: 15000 }, desktopLost: false })),
  );
  await act(async () => root.render(<ConciergeRailToggle />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(window.location.pathname).toBe('/');
  expect(vi.mocked(apiFetch).mock.calls.map(([url]) => url)).toEqual(['/api/concierge/desktop/show']);
  expect(useConciergeStore.getState().muted).toBe(true);
});

it('falls back to the original conversation if an explicit desktop show fails', async () => {
  useConciergeStore.setState({ configLoaded: true });
  useConciergeDesktopStore.setState({ available: true });
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url === '/api/concierge/desktop/show'
      ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify({ threadId: 'companion-original' })),
  );
  await act(async () => root.render(<ConciergeRailToggle />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(window.location.pathname).toBe('/thread/companion-original');
  expect(useConciergeStore.getState().muted).toBe(true);
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});

it('opens the original conversation without unmuting or enabling anything', async () => {
  useConciergeStore.setState({ configLoaded: true, threadId: 'companion-original', threadIdLoaded: true });
  await act(async () => root.render(<ConciergeRailToggle />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(window.location.pathname).toBe('/thread/companion-original');
  expect(useConciergeStore.getState().muted).toBe(true);
  expect(useConciergeStore.getState().surfaceState).toBe('collapsed');
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});

it('revalidates a passively discovered carrier through the explicit owner open before navigating', async () => {
  useConciergeStore.setState({ configLoaded: true, threadId: 'old-carrier', threadIdLoaded: true });
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ threadId: 'current-carrier' })));
  await act(async () => root.render(<ConciergeRailToggle />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(window.location.pathname).toBe('/thread/current-carrier');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([url, options]) => url === '/api/concierge/thread' && options?.method === 'POST'),
  ).toHaveLength(1);
});

it('keeps the current page and reports a failed owner open instead of using the stale carrier', async () => {
  useConciergeStore.setState({ configLoaded: true, threadId: 'old-carrier', threadIdLoaded: true });
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
  await act(async () => root.render(<ConciergeRailToggle />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(window.location.pathname).toBe('/');
  expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('重试');
});

it('does not pull the owner back after navigation while resolving the companion carrier', async () => {
  useConciergeStore.setState({ configLoaded: true, threadId: 'old-carrier', threadIdLoaded: true });
  let resolve!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<ConciergeRailToggle />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  window.history.pushState({}, '', '/thread/other-work');
  await act(async () => resolve(new Response(JSON.stringify({ threadId: 'current-carrier' }))));
  expect(window.location.pathname).toBe('/thread/other-work');
});
