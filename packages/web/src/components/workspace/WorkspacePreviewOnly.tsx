'use client';

import { BrowserPanel } from './BrowserPanel';
import { WorkspaceFocusShell } from './WorkspaceFocusShell';

interface WorkspacePreviewOnlyProps {
  initialPort?: number;
  initialPath?: string;
  onNavigate?: (port: number, path: string) => void;
  onExit: () => void;
}

/** Browser preview in focus mode — full workspace, no chrome. */
export function WorkspacePreviewOnly({ initialPort, initialPath, onNavigate, onExit }: WorkspacePreviewOnlyProps) {
  return (
    <WorkspaceFocusShell onExit={onExit}>
      <BrowserPanel initialPort={initialPort} initialPath={initialPath} previewOnly onNavigate={onNavigate} />
    </WorkspaceFocusShell>
  );
}
