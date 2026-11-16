import { act, type ReactNode, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReplyOutputSelectionSource } from '@/components/reply-layers/reply-output-selection';
import { useTextSelectionAction } from '../useTextSelectionAction';

function Host({
  source,
  display,
  excludedRecord = false,
  native = true,
}: {
  source: string;
  display: ReactNode;
  excludedRecord?: boolean;
  native?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const action = useTextSelectionAction(ref, true, source, 'viewport');
  return (
    <>
      <div ref={ref} data-context-quote-source={excludedRecord ? 'cli_output' : undefined}>
        <div
          data-testid="source"
          data-context-quote-source={excludedRecord || !native ? undefined : 'message'}
          data-quote-exclude={excludedRecord || undefined}
          ref={(node) => {
            if (node && native && !excludedRecord)
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
        </div>
      </div>
      <output data-selection-text={action?.text}>
        {action ? `${action.selectionStart}:${action.selectionEnd}` : 'none'}
      </output>
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

  it('retains the existing unmarked workspace quote when rendered heading case differs from DOM text', async () => {
    await act(async () => root.render(<Host source="title" display="title" native={false} />));
    const selection = window.getSelection();
    if (!selection) throw new Error('Missing workspace heading selection');
    vi.spyOn(window, 'getSelection').mockReturnValue({ ...selection, toString: () => 'TITLE' } as Selection);
    await act(async () => document.dispatchEvent(new Event('selectionchange')));
    expect(container.querySelector('output')?.getAttribute('data-selection-text')).toBe('TITLE');
  });

  it('keeps comments available when Chromium inserts layout newlines around inline code', async () => {
    const source = '**能发包**\n\n- 实测失败 `ENEEDAUTH`。';
    await act(async () =>
      root.render(
        <Host
          source={source}
          display={
            <>
              <p>
                <strong>能发包</strong>
              </p>
              <ul>
                <li>
                  实测失败 <code>ENEEDAUTH</code>。
                </li>
              </ul>
            </>
          }
        />,
      ),
    );
    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      const node = container.querySelector('[data-testid=source]');
      if (!node) throw new Error('Missing native answer fixture');
      const range = document.createRange();
      range.selectNodeContents(node);
      Object.defineProperties(range, {
        getClientRects: { value: () => [new DOMRect(200, 200, 100, 20)] },
      });
      return {
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => range,
        // Measured in the actual /thread host from the owner's recording.
        toString: () => '能发包\n\n实测失败 \nENEEDAUTH\n。',
      } as unknown as Selection;
    });
    await act(async () => document.dispatchEvent(new Event('selectionchange')));
    expect(container.querySelector('output')?.textContent).toBe(`122:${120 + source.length}`);
    expect(container.querySelector('output')?.getAttribute('data-selection-text')).toContain('ENEEDAUTH。');
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
