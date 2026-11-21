import { type ReactNode, act as reactAct } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { HubSocketContext } from '@/components/thread-chat/hub-socket-context';
import type { HubSocket } from '@/hooks/useSocket-hub';

export const testHub: HubSocket = {
  on: () => () => {},
  emit: () => true,
  retainRoom: () => () => {},
  onConnected: (listener) => {
    listener('pdl-test-socket');
    return () => {};
  },
  connectedSocketId: () => 'pdl-test-socket',
};

const mounted: { root: Root; container: HTMLDivElement }[] = [];
export async function act<T>(work: () => T | Promise<T>): Promise<T> {
  let value!: T;
  await reactAct(async () => {
    value = await work();
  });
  return value;
}
export function renderHook<T>(hook: () => T, children?: (value: T) => ReactNode, hub: HubSocket = testHub) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const result = { current: undefined as T },
    container = document.createElement('div'),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, container });
  function Probe() {
    result.current = hook();
    return children?.(result.current) ?? null;
  }
  reactAct(() =>
    root.render(
      <HubSocketContext.Provider value={hub}>
        <Probe />
      </HubSocketContext.Provider>,
    ),
  );
  return {
    result,
    rerender: () =>
      root.render(
        <HubSocketContext.Provider value={hub}>
          <Probe />
        </HubSocketContext.Provider>,
      ),
  };
}
export async function waitFor(assert: () => void) {
  await vi.waitFor(async () => {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert();
  });
}
export async function cleanup() {
  for (const { root, container } of mounted.splice(0)) {
    await act(() => root.unmount());
    container.remove();
  }
}
