import { type CollectiveDocumentResult, collectiveDocumentTargetKey } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { CollectiveDocumentHostTarget } from '../workbench/collective-document-surface';
import { useWorkspaceSurfaceVisibility } from '../workbench/WorkspaceSurfaceVisibility';
import { collectiveDocumentCopy } from './collective-document.shell-copy';
import {
  collectiveDocumentPortRevision,
  findCollectiveDocumentPort,
  subscribeCollectiveDocumentPorts,
} from './collective-document-port';

type Read = Extract<CollectiveDocumentResult, { kind: 'read' }>;
export function useCollectiveDocument({ target, hostKey }: CollectiveDocumentHostTarget) {
  const visible = useWorkspaceSurfaceVisibility();
  const admission = useRef({ visible: false, generation: 0 });
  if (visible && !admission.current.visible) ++admission.current.generation;
  admission.current.visible = visible;
  const copy = useShellCopy(collectiveDocumentCopy);
  const errorMessage = (code: string) =>
    (
      ({ access_denied: copy.denied, owner_unavailable: copy.ownerUnavailable, conflict: copy.conflict }) as Record<
        string,
        string
      >
    )[code] ?? copy.unavailable;
  const ports = useSyncExternalStore(subscribeCollectiveDocumentPorts, collectiveDocumentPortRevision, () => 0);
  const port = findCollectiveDocumentPort(hostKey, target);
  const key = `${hostKey}:${collectiveDocumentTargetKey(target)}:${ports}:${visible ? admission.current.generation : 'hidden'}`;
  const current = useRef(key);
  current.current = key;
  const running = useRef<string>();
  const [state, setState] = useState<{ key: string; reads?: Read[]; errorCode?: string }>({ key });
  const reload = useCallback(async () => {
    if (!visible || !port || running.current === key) return;
    running.current = key;
    try {
      const versions = [
        target.ownerRevision,
        ...(target.comparisonOwnerRevision ? [target.comparisonOwnerRevision] : []),
      ];
      const results = await Promise.all(
        versions.map((ownerRevision) => port.request(target, { kind: 'read', ownerRevision })),
      );
      if (current.current !== key) return;
      const denied = results.find((result) => result.kind !== 'read');
      if (denied) setState({ key, errorCode: denied.kind === 'error' ? denied.code : 'unavailable' });
      else setState({ key, reads: results.filter((result): result is Read => result.kind === 'read') });
    } catch {
      if (current.current === key) setState({ key, errorCode: 'unavailable' });
    } finally {
      if (running.current === key) running.current = undefined;
    }
  }, [key, port, target, visible]);
  useEffect(() => {
    if (!visible) {
      setState({ key });
      return;
    }
    void reload();
    const timer = window.setInterval(() => void reload(), 2500);
    window.addEventListener('focus', reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [reload, visible, key]);
  return {
    port,
    reload,
    key,
    reads: state.key === key && port ? state.reads : undefined,
    error:
      state.key === key && port
        ? state.errorCode
          ? errorMessage(state.errorCode)
          : undefined
        : port
          ? undefined
          : copy.connectionUnavailable,
  };
}
