import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReplyOutputSelectionSource } from '@/components/reply-layers/reply-output-selection';
import { useTextSelectionAction } from '../useTextSelectionAction';

function Host({
  source,
  display,
  excludedRecord = false,
}: {
  source: string;
  display: string;
  excludedRecord?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const action = useTextSelectionAction(ref, true, source, 'viewport');
  return (
    <>
      <div ref={ref} data-context-quote-source={excludedRecord ? 'cli_output' : undefined}>
        <span
          data-testid="source"
          data-context-quote-source={excludedRecord ? undefined : 'message'}
          data-quote-exclude={excludedRecord || undefined}
          ref={(node) => {
            if (node && !excludedRecord)
              registerReplyOutputSelectionSource(node, {
                kind: 'text',
                id: 'native',
                text: source,
                start: 120,
                end: 120 + source.length,
              });
          }}
        >
          {display}
        </span>
      </div>
      <output>{action ? `${action.selectionStart}:${action.selectionEnd}` : 'none'}</output>
    </>
  );
}

describe('native reply selection binds the original whole content, not display offset zero', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      const node = container.querySelector('[data-testid=source]')?.firstChild;
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      Object.defineProperties(range, {
        getBoundingClientRect: { value: () => new DOMRect(200, 200, 100, 20) },
        getClientRects: { value: () => [new DOMRect(200, 200, 100, 20)] },
      });
      return {
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => range,
        toString: () => range.toString(),
      } as unknown as Selection;
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  it('rejects excluded child prose even when its enclosing CLI record has no selected segment', async () => {
    await act(async () => root.render(<Host source="Child report" display="Child report" excludedRecord />));
    expect(container.querySelector('output')?.textContent).toBe('none');
  });

  it('maps a Markdown answer selection through the original source span', async () => {
    await act(async () => root.render(<Host source="**答案段**" display="答案段" />));
    expect(container.querySelector('output')?.textContent).toBe('122:125');
  });
  it('keeps transformed/generated or repeated text on the existing whole-message quote path', async () => {
    for (const [source, display] of [
      ['重复 重复', '重复'],
      ['$$x$$', '1'],
      ['原文', '改写'],
    ] as const) {
      await act(async () => root.render(<Host source={source} display={display} />));
      expect(container.querySelector('output')?.textContent).toBe('none');
    }
  });
});
