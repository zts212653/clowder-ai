import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHmrStatus } from '../useHmrStatus';

class WebSocketStub {
  static instances: WebSocketStub[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    WebSocketStub.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function Probe({ enabled }: { enabled: boolean }) {
  const status = useHmrStatus(4111, 5173, enabled);
  return <output data-testid="hmr-state">{status}</output>;
}

describe('useHmrStatus visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    WebSocketStub.instances = [];
    vi.stubGlobal('WebSocket', WebSocketStub);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(enabled: boolean) {
    await act(async () => root.render(<Probe enabled={enabled} />));
  }

  it('opens no hidden socket, closes the visible one, and cancels its retry', async () => {
    await render(false);
    expect(WebSocketStub.instances).toHaveLength(0);

    await render(true);
    expect(WebSocketStub.instances).toHaveLength(1);
    const first = WebSocketStub.instances[0];
    await act(async () => first.onopen?.());
    expect(container.textContent).toBe('connected');

    await act(async () => first.onclose?.());
    expect(container.textContent).toBe('disconnected');
    await render(false);
    expect(first.closed).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(WebSocketStub.instances).toHaveLength(1);

    await render(true);
    expect(WebSocketStub.instances).toHaveLength(2);
  });
});
