import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { artifactObjectId } from '../workbench/real-surface-adapters';

/** Home is a presentation origin, never a fabricated Workbench return surface. C owns admission and restoration. */
export interface WorkspaceHomeArtifactOrigin {
  readonly kind: 'workspace-home-artifact';
  readonly threadId: string;
  readonly artifactId: string;
  readonly viewportOffsetPx: number;
}
export function captureHomeArtifactOrigin(
  threadId: string,
  artifact: ThreadArtifactDTO,
  card: HTMLElement,
  viewport: HTMLElement,
): WorkspaceHomeArtifactOrigin {
  return {
    kind: 'workspace-home-artifact',
    threadId,
    artifactId: artifactObjectId(artifact),
    viewportOffsetPx: card.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
  };
}
