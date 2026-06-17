import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PresentationFloatView } from '../PresentationFloatView';

Object.assign(globalThis as Record<string, unknown>, { React });

const baseProps = {
  content: {
    worktreeId: 'wt-main',
    filePath: 'docs/讲稿.md',
    tabs: ['docs/讲稿.md'],
    fileKind: 'markdown' as const,
    renderMode: 'rendered' as const,
    line: null,
    scrollTop: null,
    title: '讲稿.md',
  },
  pos: { x: 120, y: 120 },
  size: { width: 420, height: 480 },
  fileContent: null as string | null,
  rawSrc: 'http://localhost:3102/api/workspace/file/raw?worktreeId=wt-main&path=docs%2F%E8%AE%B2%E7%A8%BF.md',
  maximized: false,
  onDockBack: () => {},
  onClose: () => {},
  onMinimize: () => {},
  onDragStop: () => {},
  onResizeStop: () => {},
  onToggleMaximize: () => {},
};

describe('PresentationFloatView (F226 floating window)', () => {
  it('renders file name + pin in header (烁烁 P2-1/P2-4)', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} />);
    expect(html).toContain('讲稿.md');
    expect(html).toContain('\u{1F4CC}'); // 📌 pin marker
  });

  it('renders dock-back control (回坞)', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} />);
    expect(html).toContain('回坞');
  });

  it('renders minimized bar with pin + title', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={true} />);
    expect(html).toContain('讲稿.md');
    expect(html).toContain('\u{1F4CC}');
  });

  it('shows loading state when text file content not fetched yet', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} fileContent={null} />);
    expect(html).toContain('加载');
  });

  it('renders raw text content for non-markdown files', () => {
    const codeProps = {
      ...baseProps,
      content: {
        ...baseProps.content,
        filePath: 'src/app.ts',
        fileKind: 'file' as const,
        renderMode: 'raw' as const,
        title: 'app.ts',
      },
    };
    const html = renderToStaticMarkup(
      <PresentationFloatView {...codeProps} minimized={false} fileContent={'const x = 1;'} />,
    );
    expect(html).toContain('const x = 1;');
  });

  it('renders an image via raw src for image kind', () => {
    const imgProps = {
      ...baseProps,
      content: {
        ...baseProps.content,
        filePath: 'assets/slide-3.png',
        fileKind: 'image' as const,
        renderMode: 'raw' as const,
        title: 'slide-3.png',
      },
    };
    const html = renderToStaticMarkup(<PresentationFloatView {...imgProps} minimized={false} />);
    expect(html).toContain('<img');
    expect(html).toContain('slide-3.png');
  });

  it('passes basePath so subdirectory markdown relative images resolve to workspace URLs (云端 P2)', () => {
    const mdProps = {
      ...baseProps,
      content: {
        ...baseProps.content,
        filePath: 'docs/sub/讲稿.md',
        fileKind: 'markdown' as const,
        renderMode: 'rendered' as const,
        title: '讲稿.md',
      },
    };
    const html = renderToStaticMarkup(
      <PresentationFloatView {...mdProps} minimized={false} fileContent={'![diagram](./diagram.png)'} />,
    );
    // basePath='docs/sub' makes the relative image resolve under the file's dir as a workspace raw URL
    // (without basePath, MarkdownContent skips the resolver and renders a broken './diagram.png').
    expect(html).toContain('file/raw');
    expect(html).toContain('docs%2Fsub%2Fdiagram.png');
  });

  it('confines dragging to the header so the document body stays selectable/clickable (云端 P2)', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} fileContent={'# doc'} />);
    // Rnd dragHandleClassName + header carries f226-float-drag-handle → only the header initiates a
    // drag; the scrollable body no longer hijacks text selection / link clicks into a window move.
    expect(html).toContain('f226-float-drag-handle');
  });

  it('disables command-prefix parsing so slash-prefixed files render like the docked viewer (云端 P2)', () => {
    const html = renderToStaticMarkup(
      <PresentationFloatView {...baseProps} minimized={false} fileContent={'/api reference guide'} />,
    );
    // Without disableCommandPrefix, MarkdownContent strips a leading /\w+ as a chat command, so the
    // float would show a different doc than docked FileContentRenderer (which sets disableCommandPrefix).
    expect(html).toContain('/api');
  });

  it('uses a non-modal z-index so open modal backdrops cover the float (云端 P2)', () => {
    const full = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} fileContent={'# doc'} />);
    const min = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={true} />);
    // z-[35] sits above the sidebar (z-30) but below MobileStatusSheet backdrop (z-40) and dialogs
    // (z-50+), so an open backdrop actually covers the float — consistent with Esc deferring to it.
    expect(full).toContain('z-[35]');
    expect(full).not.toContain('z-40');
    expect(min).toContain('z-[35]');
  });

  it('minimized + full carry distinct Rnd keys so React remounts on toggle (云端 P2)', () => {
    // react-rnd applies `default` geometry only at mount. Without distinct keys the unkeyed Rnd is
    // reused across the minimize toggle and keeps the full 420-wide size instead of shrinking to the
    // 260×36 bar. Distinct keys force a remount. PresentationFloatView is a pure function, so we read
    // the returned element's key directly (react-rnd doesn't emit `default` geometry in SSR markup).
    const minEl = PresentationFloatView({ ...baseProps, minimized: true });
    const fullEl = PresentationFloatView({ ...baseProps, minimized: false, fileContent: '# doc' });
    expect(minEl.key).toBe('f226-float-minimized');
    expect(fullEl.key).toBe('f226-float-full-normal');
    expect(minEl.key).not.toBe(fullEl.key);
  });

  // ── F226 尺寸快捷 enhancement（co-creator dogfood）──

  it('renders 适配 PPT (⤢) control; maximized shows restore glyph (⤡) with distinct key for remount', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} fileContent={'# doc'} />);
    expect(html).toContain('⤢'); // ⤢ 适配 PPT glyph (not maximized)
    // maximized 态：key 变 → react-rnd remount 应用放大 geometry；图标变还原 ⤡
    const maxEl = PresentationFloatView({ ...baseProps, minimized: false, maximized: true, fileContent: '# doc' });
    expect(maxEl.key).toBe('f226-float-full-max');
    const maxHtml = renderToStaticMarkup(
      <PresentationFloatView {...baseProps} minimized={false} maximized={true} fileContent={'# doc'} />,
    );
    expect(maxHtml).toContain('⤡'); // ⤡ restore glyph
  });

  it('drops backdrop-blur so the float is a solid panel readable over the dark chat area (co-creator dogfood)', () => {
    const html = renderToStaticMarkup(<PresentationFloatView {...baseProps} minimized={false} fileContent={'# doc'} />);
    // 毛玻璃在深色聊天区透字不清；演示讲稿首要清晰 → 实底面板
    expect(html).not.toContain('backdrop-blur');
  });
});
