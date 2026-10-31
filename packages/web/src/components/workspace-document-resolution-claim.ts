import { useChatStore } from '@/stores/chatStore';
import { getBrowserThreadRoutePathname, subscribeBrowserThreadRoute } from './ThreadSidebar/thread-navigation';

export interface WorkspaceDocumentResolutionClaim {
  cancelled: boolean;
  cancel: () => void;
  finish: () => void;
}

let activeClaim: WorkspaceDocumentResolutionClaim | null = null;

export function cancelActiveWorkspaceDocumentResolution(): void {
  activeClaim?.cancel();
}

export function claimWorkspaceDocumentResolution(
  originThreadId: string,
  onCancel: () => void,
): WorkspaceDocumentResolutionClaim {
  cancelActiveWorkspaceDocumentResolution();
  const originPathname = getBrowserThreadRoutePathname();
  let unsubscribeStore = () => {};
  let unsubscribeRoute = () => {};
  const unsubscribe = () => {
    unsubscribeStore();
    unsubscribeRoute();
  };
  const claim: WorkspaceDocumentResolutionClaim = {
    cancelled: false,
    cancel: () => {
      if (claim.cancelled) return;
      claim.cancelled = true;
      unsubscribe();
      if (activeClaim === claim) activeClaim = null;
      onCancel();
    },
    finish: () => {
      unsubscribe();
      if (activeClaim === claim) activeClaim = null;
    },
  };
  unsubscribeStore = useChatStore.subscribe((state) => {
    if (state.currentThreadId !== originThreadId) claim.cancel();
  });
  unsubscribeRoute = subscribeBrowserThreadRoute(() => {
    if (getBrowserThreadRoutePathname() !== originPathname) claim.cancel();
  });
  activeClaim = claim;
  return claim;
}
