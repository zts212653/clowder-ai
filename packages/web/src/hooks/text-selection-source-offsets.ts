import { projectDomSelectionOffsets, type SelectionOffsetSource } from '@cat-cafe/ui';
import {
  hasReplyOutputSelectionSource,
  replyOutputSelectionOffsets,
} from '@/components/reply-layers/reply-output-selection';

export function projectedSelectionOffsets(source: SelectionOffsetSource, selection: Selection, container: HTMLElement) {
  if (source.coordinateRoot && hasReplyOutputSelectionSource(source.coordinateRoot)) {
    return replyOutputSelectionOffsets(source.coordinateRoot, selection.toString());
  }
  return projectDomSelectionOffsets(source, selection, container);
}

export function isUnmappedNativeSelection(
  root: Element | null,
  offsets: { start: number; end: number } | null,
): boolean {
  return Boolean(root && hasReplyOutputSelectionSource(root) && !offsets);
}
