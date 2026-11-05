import {
  type CollectiveDocumentRequest,
  type CollectiveDocumentResult,
  type CollectiveDocumentTarget,
} from '@cat-cafe/shared';

export interface CollectiveDocumentPort {
  readonly hostKey: string;
  matches(target: CollectiveDocumentTarget): boolean;
  request(
    target: CollectiveDocumentTarget,
    operation: CollectiveDocumentRequest['operation'],
  ): Promise<CollectiveDocumentResult>;
  returnTo(target: CollectiveDocumentTarget, destination: 'project' | 'source' | 'discussion'): boolean;
}
const ports = new Map<string, CollectiveDocumentPort>();
const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  ++revision;
  for (const listener of listeners) listener();
}
export function registerCollectiveDocumentPort(port: CollectiveDocumentPort) {
  ports.set(port.hostKey, port);
  changed();
  return () => {
    if (ports.get(port.hostKey) === port) {
      ports.delete(port.hostKey);
      changed();
    }
  };
}
export const subscribeCollectiveDocumentPorts = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const collectiveDocumentPortRevision = () => revision;
export function findCollectiveDocumentPort(hostKey: string, target: CollectiveDocumentTarget) {
  const port = ports.get(hostKey);
  return port?.matches(target) ? port : undefined;
}
