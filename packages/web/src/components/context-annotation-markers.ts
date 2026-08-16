import type { QuoteContextAttachment } from '@cat-cafe/shared';

export interface ContextAnnotationMarker {
  attachment: QuoteContextAttachment;
  number: number;
  position: { top: number; left: number };
}

function annotationSourceRoot(root: HTMLElement, attachment: QuoteContextAttachment): HTMLElement | null {
  if (attachment.source.kind === 'cli_output') {
    const { segmentId } = attachment.source;
    if (!segmentId) return null;
    return (
      Array.from(root.querySelectorAll<HTMLElement>('[data-context-quote-segment-id]')).find(
        (candidate) => candidate.getAttribute('data-context-quote-segment-id') === segmentId,
      ) ?? null
    );
  }
  return root;
}

function isAnnotationUi(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element?.closest('[data-context-annotation-ui]'));
}

export function rangeFromTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isAnnotationUi(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const nextOffset = offset + text.data.length;
    if (!startNode && start >= offset && start <= nextOffset) {
      startNode = text;
      startOffset = start - offset;
    }
    if (end >= offset && end <= nextOffset) {
      endNode = text;
      endOffset = end - offset;
      break;
    }
    offset = nextOffset;
  }

  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

export function positionAnnotationMarkers(
  root: HTMLElement,
  annotations: readonly { attachment: QuoteContextAttachment; number: number }[],
): ContextAnnotationMarker[] {
  return annotations.flatMap(({ attachment, number }) => {
    if (attachment.selectionStart === undefined || attachment.selectionEnd === undefined) return [];
    const sourceRoot = annotationSourceRoot(root, attachment);
    if (!sourceRoot) return [];
    const range = rangeFromTextOffsets(sourceRoot, attachment.selectionStart, attachment.selectionEnd);
    if (!range || typeof range.getBoundingClientRect !== 'function') return [];
    if (range.toString().trim() !== attachment.text) return [];
    const rect = range.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return [];
    return [
      {
        attachment,
        number,
        position: {
          top: Math.round(Math.max(8, rect.top - 8)),
          left: Math.round(Math.min(window.innerWidth - 32, rect.right + 8)),
        },
      },
    ];
  });
}
