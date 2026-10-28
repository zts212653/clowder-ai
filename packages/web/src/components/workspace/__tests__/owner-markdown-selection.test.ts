import { expect, it } from 'vitest';
import { ownerMarkdownSelection } from '../useMarkdownSelectionAction';

it('maps a repeated rendered block to its exact raw Markdown interval without guessing the first occurrence', () => {
  const source = '# Guide\n\nThe **same** passage\n\nThe **same** passage';
  const container = document.createElement('div');
  document.body.append(container);
  container.innerHTML =
    '<h1 data-source-line="1">Guide</h1><p data-source-line="3">The <strong>same</strong> passage</p><p data-source-line="5">The <strong>same</strong> passage</p>';
  try {
    const block = container.lastElementChild;
    if (!block) throw new Error('Missing selected block');
    const range = document.createRange();
    range.selectNodeContents(block);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const span = ownerMarkdownSelection(container, source, 'The same passage');
    expect(span?.start).toBe(source.lastIndexOf('The **same** passage'));
    expect(span && source.slice(span.start, span.end)).toBe('The **same** passage');
    window.getSelection()?.removeAllRanges();
    expect(ownerMarkdownSelection(container, source, 'The same passage')).toBeNull();
  } finally {
    window.getSelection()?.removeAllRanges();
    container.remove();
  }
});
