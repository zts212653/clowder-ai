import { resolveSharedMarkdownSelection } from '@cat-cafe/shared';

export { resolveSharedMarkdownSelection } from '@cat-cafe/shared';

export function sharedMarkdownDomSelection(paper: HTMLElement, event: Event, source: string) {
  if (!(event.target instanceof Node) || !paper.contains(event.target)) return undefined;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!paper.contains(range.commonAncestorContainer)) return undefined;
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>('[data-source-start]');
  const bounds = block ? { start: Number(block.dataset.sourceStart), end: Number(block.dataset.sourceEnd) } : undefined;
  return resolveSharedMarkdownSelection(source, selection.toString(), bounds);
}
