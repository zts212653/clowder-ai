import { type ReactNode, useRef } from 'react';
import { HubSocketContext } from '../../../src/components/thread-chat/hub-socket-context';
import { useHubSocketOutlet } from '../../../src/hooks/useSocket-hub';

// Owners outside this shell slice are not mounted. AppShell, both rails, settings,
// navigation hooks and their stores remain production code in the browser bundle.
export function ThreadChatRuntimeProvider({ children }: { children: ReactNode }) {
  // The shell uses the page outlet, while transport remains outside this bounded host.
  const socket = useRef(null);
  const { hub } = useHubSocketOutlet(socket);
  return <HubSocketContext.Provider value={hub}>{children}</HubSocketContext.Provider>;
}
export function ThreadSidebar() {
  return null;
}
export function CallbackAuthSnapshotMount() {
  return null;
}
export function DesktopUpdatePrompt() {
  return null;
}
export function ConciergeHost() {
  return null;
}
export function ListenModePlayer() {
  return null;
}
export function TheaterReplayHost() {
  return null;
}
export function FloatingPresentationSurfaceHost() {
  return null;
}
export function ResizeHandle() {
  return null;
}
export function useWorkspaceNavigate() {}
export function WorkspaceNavigateHost() {
  return null;
}
// The socket-backed hook above stays a boundary. The two navigation functions are plain DOM/router helpers and are what the
// 待办 panel actually calls to reach a source message, so the journey runs them for real. Imported by relative path so the
// '@/hooks/useWorkspaceNavigate' alias does not point back at this file.
export {
  navigateToEntrustedWorkAction,
  resolveEntrustedWorkActionTarget,
} from '../../../src/hooks/useWorkspaceNavigate';
export function getPlaybackManager() {}
export function destroyPlaybackRuntime() {}
