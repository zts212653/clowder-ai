export interface SelectionOffsetSource {
  kind: string | null;
  coordinateRoot: Element | null;
  coordinateRange: Range | null;
}

function selectionOffsets(range: Range, container: Node): { start: number; end: number } | null {
  if (typeof range.cloneRange !== 'function') return null;
  try {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(container);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const end = start + range.toString().length;
    return end > start ? { start, end } : null;
  } catch {
    return null;
  }
}

function trimSelectionOffsets(
  offsets: { start: number; end: number } | null,
  rawText: string,
): { start: number; end: number } | null {
  if (!offsets) return null;
  const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
  const trailingWhitespaceLength = rawText.length - rawText.trimEnd().length;
  return { start: offsets.start + leadingWhitespaceLength, end: offsets.end - trailingWhitespaceLength };
}

export function projectDomSelectionOffsets(
  source: SelectionOffsetSource,
  selection: Selection,
  container: HTMLElement,
) {
  const offsetRoot = source.kind === 'cli_output' ? source.coordinateRoot : (source.coordinateRoot ?? container);
  const offsetRange = source.coordinateRange ?? selection.getRangeAt(0);
  const offsetRawText = source.coordinateRange?.toString() ?? selection.toString();
  return trimSelectionOffsets(offsetRoot ? selectionOffsets(offsetRange, offsetRoot) : null, offsetRawText);
}
