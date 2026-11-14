import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { HubSocketContext } from '@/components/thread-chat/hub-socket-context';
import type { HubSocket } from '@/hooks/useSocket-hub';
import { createFakeHubSocket } from './fake-hub-socket-core';

export { createFakeHubSocket, type FakeHubSocket } from './fake-hub-socket-core';

export function FakeHubSocketProvider({ hub, children }: { hub: HubSocket; children?: ReactNode }) {
  return <HubSocketContext.Provider value={hub}>{children}</HubSocketContext.Provider>;
}

/** A root whose renders run inside a fake page connection, for components that use useHubSocket. */
export function withHubSocket(root: Root, hub: HubSocket = createFakeHubSocket().hub): Root {
  return {
    render: (children: ReactNode) => root.render(<FakeHubSocketProvider hub={hub}>{children}</FakeHubSocketProvider>),
    unmount: () => root.unmount(),
  };
}
