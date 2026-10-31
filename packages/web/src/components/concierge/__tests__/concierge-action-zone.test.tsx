import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConciergeStore } from '@/stores/conciergeStore';
import { ConciergeHost } from '../ConciergeHost';

const ports = vi.hoisted(() => ({
  watch: vi.fn(),
  stopWatching: vi.fn(),
  open: vi.fn(),
  config: vi.fn(),
  existing: vi.fn(),
}));
vi.mock('@/stores/conciergeDesktopStore', () => ({ watchConciergeDesktop: () => ports.watch() }));
vi.mock('../companion-entry', () => ({ openCompanionConversation: () => ports.open() }));

let root: Root;
let container: HTMLDivElement;
const initial = useConciergeStore.getState();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ports.watch.mockReturnValue(ports.stopWatching);
  ports.open.mockResolvedValue(undefined);
  ports.config.mockResolvedValue(undefined);
  ports.existing.mockResolvedValue(undefined);
  useConciergeStore.setState({
    ...initial,
    surfaceState: 'collapsed',
    fetchConfig: ports.config,
    readExistingThreadId: ports.existing,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useConciergeStore.setState(initial);
  vi.clearAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ConciergeHost after the upstream floating-shell retirement', () => {
  it('keeps configuration and desktop observation without putting a floating owner over Queue actions', async () => {
    await act(async () => root.render(<ConciergeHost />));
    expect(ports.config).toHaveBeenCalledOnce();
    expect(ports.existing).toHaveBeenCalledOnce();
    expect(ports.watch).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
    expect(ports.open).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(ports.stopWatching).toHaveBeenCalledOnce();
  });

  it('routes an existing explicit capability-tip draft to the conversation, without reviving the old ball', async () => {
    await act(async () => root.render(<ConciergeHost />));
    await act(async () => useConciergeStore.setState({ surfaceState: 'bubble' }));
    expect(ports.open).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
    await act(async () => useConciergeStore.setState({ muted: true, ballPosition: { x: 200, y: 300 } }));
    expect(ports.open).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
  });
});
