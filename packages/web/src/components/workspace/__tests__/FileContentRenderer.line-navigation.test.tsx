// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileContentRenderer, type FileContentRendererProps } from '../FileContentRenderer';

let host: HTMLDivElement;
let root: Root;
let scrollIntoViewMock: ReturnType<typeof vi.fn>;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  scrollIntoViewMock = vi.fn();
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('scrolls rendered Markdown to the source block at or before the requested line', () => {
  const mdContainerRef = createRef<HTMLDivElement>();
  const props: FileContentRendererProps = {
    file: {
      path: 'README.md',
      content: '# Intro\n\nOpening text.\n\n## Target section\n\nTarget body.',
      size: 62,
      sha256: 'digest',
      mime: 'text/markdown',
      truncated: false,
    },
    openFilePath: 'README.md',
    isMarkdown: true,
    isHtml: false,
    isJsx: false,
    markdownRendered: true,
    htmlPreview: false,
    jsxPreview: false,
    editMode: false,
    scrollToLine: 6,
    worktreeId: 'fixture',
    mdContainerRef,
    mdSelectionAction: null,
    onMdAddToChat: () => undefined,
    onSave: async () => undefined,
    rawUrl: () => '',
  };

  act(() => root.render(<FileContentRenderer {...props} />));

  expect(scrollIntoViewMock.mock.contexts.at(-1)).toBe(mdContainerRef.current?.querySelector('[data-source-line="5"]'));
});

it.each([
  { path: 'foo.conf', binary: false },
  { path: 'Cargo.lock', binary: false },
  { path: 'foo.conf', binary: true },
])('uses the byte-reader binary=$binary decision for $path, regardless of generic MIME', ({ path, binary }) => {
  const props: FileContentRendererProps = {
    file: {
      path,
      content: 'a=1',
      size: 3,
      sha256: 'digest',
      mime: 'application/octet-stream',
      truncated: false,
      binary,
    },
    openFilePath: path,
    isMarkdown: false,
    isHtml: false,
    isJsx: false,
    markdownRendered: false,
    htmlPreview: false,
    jsxPreview: false,
    editMode: false,
    scrollToLine: null,
    worktreeId: 'fixture',
    mdContainerRef: createRef<HTMLDivElement>(),
    mdSelectionAction: null,
    onMdAddToChat: () => undefined,
    rawUrl: () => '',
  };
  act(() => root.render(<FileContentRenderer {...props} />));
  if (binary) expect(host.textContent).toContain('二进制文件');
  else {
    expect(host.textContent).toContain('a=1');
    expect(host.textContent).not.toContain('二进制文件');
  }
});
