import { ChatVoiceFeatureControls } from '@/components/ChatVoiceFeatureControls';
import { VideoProjectList } from './video-project/VideoProjectList';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

/** Voice and film tools reuse their original owners; legacy now tabs return through the host. */
export function WorkspaceAuxiliaryOwnerSurface({
  destination,
  threadId,
  defaultCatId,
  onOpenSurface,
}: {
  destination: 'host:now' | 'host:voice' | 'host:films';
  threadId: string | null;
  defaultCatId: string;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  if (destination === 'host:voice')
    return <ChatVoiceFeatureControls threadId={threadId ?? undefined} defaultCatId={defaultCatId} />;
  if (destination === 'host:films') return <VideoProjectList onOpen={onOpenSurface} />;
  return null;
}
