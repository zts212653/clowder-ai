'use client';

import { RightStatusPanel, type RightStatusPanelProps } from '../RightStatusPanel';
import { useShellPresentation } from '../shell/shell-presentation';
import { WorkspaceStatusPanelV2 } from './WorkspaceStatusPanelV2';

/** The two host entries share data; classic keeps its original presentation. */
export function StatusPresentation(props: RightStatusPanelProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? <WorkspaceStatusPanelV2 {...props} /> : <RightStatusPanel {...props} />;
}
