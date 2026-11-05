import { resolveWorkspaceDestinationTarget } from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

/** Keep persisted descriptors readable, but direct explicit visits to their single current entry. */
export function retiredWorkspaceDestination(surface: WorkspaceSurfaceDescriptor): 'home' | 'mailbox' | null {
  const ref = resolveWorkspaceDestinationTarget(surface)?.destinationRef;
  if (ref === 'host:now') return 'home';
  if (ref === 'mode:needs-me') return 'mailbox';
  return null;
}
