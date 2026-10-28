import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeViewer } from '../CodeViewer';
import { FileContentRenderer } from '../FileContentRenderer';

vi.mock('@/components/SelectionAnnotationAction', () => ({ SelectionAnnotationAction: () => null }));
vi.mock('@/utils/api-client', () => ({ apiFetch: async () => new Response(JSON.stringify({ userId: 'operator' })) }));

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const saveScroll = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  frames = new Map();
  nextFrame = 1;
  saveScroll.mockReset();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(kind: 'code' | 'markdown') {
  const mdContainerRef = createRef<HTMLDivElement>();
  await act(async () =>
    root.render(
      kind === 'code' ? (
        <CodeViewer
          content="original text"
          mime="text/plain"
          path="notes.txt"
          scrollToLine={null}
          restoreScrollTop={0}
          onScrollTopChange={saveScroll}
        />
      ) : (
        <FileContentRenderer
          file={{
            path: 'README.md',
            content: '# Heading\n\nBody',
            size: 15,
            sha256: 'digest',
            mime: 'text/markdown',
            truncated: false,
          }}
          openFilePath="README.md"
          isMarkdown
          isHtml={false}
          isJsx={false}
          markdownRendered
          htmlPreview={false}
          jsxPreview={false}
          editMode={false}
          scrollToLine={null}
          worktreeId="fixture"
          mdContainerRef={mdContainerRef}
          mdSelectionAction={null}
          onMdAddToChat={() => undefined}
          onSave={async () => undefined}
          rawUrl={() => ''}
          restoreScrollTop={0}
          onScrollTopChange={saveScroll}
        />
      ),
    ),
  );
  const scroller = kind === 'code' ? host.querySelector<HTMLElement>('.cm-scroller') : mdContainerRef.current;
  if (!scroller) throw new Error(`Missing ${kind} scroll viewport`);
  saveScroll.mockClear();
  return scroller;
}

for (const kind of ['code', 'markdown'] as const) {
  describe(`${kind} viewer scroll persistence`, () => {
    it('flushes the final scroll position once when unmounted before the animation frame', async () => {
      const scroller = await render(kind);
      scroller.scrollTop = 300;
      act(() => scroller.dispatchEvent(new Event('scroll')));
      scroller.scrollTop = 411;
      act(() => scroller.dispatchEvent(new Event('scroll')));
      expect(saveScroll).not.toHaveBeenCalled();
      act(() => root.render(null));
      expect(saveScroll).toHaveBeenCalledExactlyOnceWith(411);
    });

    it('does not save the same position again after the scroll frame has already completed', async () => {
      const scroller = await render(kind);
      const beforeScroll = new Set(frames.keys());
      scroller.scrollTop = 300;
      act(() => scroller.dispatchEvent(new Event('scroll')));
      const scrollFrames = [...frames].filter(([id]) => !beforeScroll.has(id));
      expect(scrollFrames.length).toBeGreaterThan(0);
      act(() => {
        for (const [id, callback] of scrollFrames) {
          frames.delete(id);
          callback(16);
        }
      });
      expect(saveScroll).toHaveBeenCalledExactlyOnceWith(300);
      act(() => root.render(null));
      expect(saveScroll).toHaveBeenCalledExactlyOnceWith(300);
    });
  });
}
