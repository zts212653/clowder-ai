'use client';

import { BrowserPanel } from './BrowserPanel';
import { WorkspaceFocusShell } from './WorkspaceFocusShell';

interface WorkspacePreviewOnlyProps {
  initialPort?: number;
  initialPath?: string;
  onNavigate?: (port: number, path: string) => void;
  onExit: () => void;
}

/**
 * Minimal preview-only shell used by WorkspacePanel.
 * Keeps exit controls and keyboard escape handling in one small component.
 */
export function WorkspacePreviewOnly({ initialPort, initialPath, onNavigate, onExit }: WorkspacePreviewOnlyProps) {
  return (
    <WorkspaceFocusShell onExit={onExit}>
      <BrowserPanel initialPort={initialPort} initialPath={initialPath} onNavigate={onNavigate} previewOnly />
    </WorkspaceFocusShell>
  );
}
