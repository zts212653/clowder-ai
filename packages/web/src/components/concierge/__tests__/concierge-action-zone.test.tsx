import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rnd = vi.hoisted(() => ({
  onDragStart: null as null | ((_event: unknown, position: { x: number; y: number }) => void),
  onDragStop: null as null | ((_event: unknown, position: { x: number; y: number }) => void),
}));

vi.mock('react-rnd', () => ({
  Rnd: ({
    position,
    onDragStart,
    onDragStop,
    children,
  }: {
    position: { x: number; y: number };
    onDragStart: typeof rnd.onDragStart;
    onDragStop: typeof rnd.onDragStop;
    children: React.ReactNode;
  }) => {
    rnd.onDragStart = onDragStart;
    rnd.onDragStop = onDragStop;
    return (
      <div data-testid="concierge-ball-wrapper" data-x={position.x} data-y={position.y}>
        {children}
      </div>
    );
  },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ config: { enabled: true, muted: false, behaviorEnabled: false } }),
    }),
  ),
  API_URL: 'http://localhost:3003',
  resolveApiUrl: () => 'http://localhost:3003',
}));

import { useConciergeStore } from '@/stores/conciergeStore';
import { ConciergeHost } from '../ConciergeHost';

let root: Root;
let container: HTMLDivElement;
let footer: HTMLDivElement;
let footerTop: number;
let resizeCallback: (() => void) | null;

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function ballPosition() {
  const ball = container.querySelector('[data-testid="concierge-ball-wrapper"]');
  return { x: Number(ball?.getAttribute('data-x')), y: Number(ball?.getAttribute('data-y')) };
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1643 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 997 });
  footerTop = 813;
  resizeCallback = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  footer = document.createElement('div');
  footer.setAttribute('data-concierge-action-zone', '');
  footer.getBoundingClientRect = () =>
    ({
      left: 292,
      top: footerTop,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth - 292,
      height: window.innerHeight - footerTop,
    }) as DOMRect;
  document.body.appendChild(footer);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useConciergeStore.setState({
    configLoaded: true,
    configLoading: false,
    configFailed: false,
    enabled: true,
    muted: false,
    behaviorEnabled: false,
    surfaceState: 'collapsed',
    ballPosition: null,
    ballSize: 72,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  footer.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ConciergeHost action-zone wiring', () => {
  it('does not observe layout while the pet is hidden', async () => {
    useConciergeStore.setState({ muted: true, surfaceState: 'collapsed' });
    await act(async () => root.render(<ConciergeHost />));
    expect(container.querySelector('[data-testid="concierge-ball-wrapper"]')).toBeNull();
    expect(resizeCallback).toBeNull();
  });

  it('moves the default ball above the queue and follows the footer when it grows', async () => {
    await act(async () => root.render(<ConciergeHost />));
    await flushEffects();
    expect(ballPosition()).toEqual({ x: 1547, y: 689 });

    footerTop = 700;
    await act(async () => resizeCallback?.());
    expect(ballPosition()).toEqual({ x: 1547, y: 576 });

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    footerTop = 570;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(ballPosition()).toEqual({ x: 1004, y: 446 });

    footer.remove();
    await flushEffects();
    expect(ballPosition()).toEqual({ x: 1004, y: 660 });
  });

  it('keeps dragging but snaps a drop over the actions to a clear position', async () => {
    await act(async () => root.render(<ConciergeHost />));
    await flushEffects();

    act(() => rnd.onDragStart?.(null, { x: 1547, y: 689 }));
    await act(async () => rnd.onDragStop?.(null, { x: 1547, y: 865 }));
    expect(useConciergeStore.getState().ballPosition).toEqual({ x: 1547, y: 689 });
    expect(ballPosition()).toEqual({ x: 1547, y: 689 });
  });

  it('reprojects a persisted position on resize without overwriting it', async () => {
    const desired = { x: 1547, y: 857 };
    useConciergeStore.setState({ ballPosition: desired });
    await act(async () => root.render(<ConciergeHost />));
    await flushEffects();
    expect(ballPosition()).toEqual({ x: 1547, y: 689 });

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    footerTop = 570;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(ballPosition()).toEqual({ x: 1028, y: 446 });
    expect(useConciergeStore.getState().ballPosition).toEqual(desired);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1643 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 997 });
    footerTop = 813;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(ballPosition()).toEqual({ x: 1547, y: 689 });
    expect(useConciergeStore.getState().ballPosition).toEqual(desired);
  });

  it('uses the current viewport after resizing while hidden, then showing', async () => {
    useConciergeStore.setState({ muted: true, surfaceState: 'collapsed' });
    await act(async () => root.render(<ConciergeHost />));

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    footerTop = 570;
    await act(async () => window.dispatchEvent(new Event('resize')));
    await act(async () => useConciergeStore.setState({ muted: false }));
    await flushEffects();

    expect(ballPosition()).toEqual({ x: 1004, y: 446 });
  });

  it('drops old action zones after hiding and navigating away', async () => {
    await act(async () => root.render(<ConciergeHost />));
    await flushEffects();
    expect(ballPosition()).toEqual({ x: 1547, y: 689 });

    await act(async () => useConciergeStore.setState({ muted: true }));
    footer.remove();
    await flushEffects();
    await act(async () => useConciergeStore.setState({ muted: false }));
    await flushEffects();

    expect(ballPosition()).toEqual({ x: 1547, y: 857 });
  });
});
