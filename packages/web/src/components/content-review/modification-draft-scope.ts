import type { ContentModificationRequest } from '@cat-cafe/shared';
import { type ModificationDraft, modificationSourceVersion } from './modification-draft';

export function needsNewModificationSelection(draft: ModificationDraft) {
  return Boolean(draft.intent?.selection || draft.intent?.imageEdit?.kind === 'erase-region');
}
/** Only an explicitly adopted, freshly captured scope can replace coordinates on another source version. */
export function rebaseModificationDraft(
  draft: ModificationDraft,
  source: ContentModificationRequest['source'],
  fresh?: {
    sourceVersion?: string;
    intent?: ModificationDraft['intent'];
  },
): ModificationDraft | null {
  const sourceVersion = modificationSourceVersion(source);
  if (draft.operation || draft.requestId || sourceVersion === draft.sourceVersion) return null;
  const selection = fresh?.sourceVersion === sourceVersion ? fresh.intent?.selection : undefined;
  if (needsNewModificationSelection(draft) && !selection) return null;
  const originalEdit = draft.intent?.imageEdit;
  if (originalEdit?.kind === 'erase-region' && selection?.kind !== 'image-region') return null;
  if (
    selection?.kind === 'text_quote' &&
    (source.kind !== 'workspace' || selection.baseRevision !== source.expectedSourceRevision)
  )
    return null;
  const imageEdit =
    originalEdit?.kind === 'erase-region' && selection?.kind === 'image-region'
      ? {
          kind: 'erase-region' as const,
          region: { x: selection.x, y: selection.y, width: selection.width, height: selection.height },
        }
      : originalEdit;
  return {
    ...draft,
    sourceVersion,
    intent: { ...(selection ? { selection } : {}), ...(imageEdit ? { imageEdit } : {}) },
    previousScopes: [
      ...(draft.previousScopes ?? []),
      {
        sourceVersion: draft.sourceVersion,
        targetCatId: draft.targetCatId,
        threadId: draft.threadId,
        ...(draft.intent ? { intent: draft.intent } : {}),
      },
    ],
  };
}
