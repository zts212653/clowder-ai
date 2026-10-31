import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileToolbar } from '@/components/content-review/FileToolbar';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { F307SurfacePane } from '../F307SurfacePane';
import { createArtifactSurface } from '../real-surface-adapters';
import { WorkspaceSurfaceVisibilityProvider } from '../WorkspaceSurfaceVisibility';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState } from '../workbench-model';

const SURFACE: WorkspaceSurfaceDescriptor = {
  id: 'browser:chess',
  type: 'browser',
  renderer: 'browser-preview',
  title: '象棋',
  context: 'localhost:3147',
  objectRef: { kind: 'preview-session', id: 'chess' },
  ownerStateRef: { owner: 'f120-browser-preview', key: 'chess' },
  resultTargetRef: { owner: 'f120-browser-preview', key: '3147:/' },
  capabilities: {
    split: true,
    sidecar: true,
    pin: true,
    closePolicy: 'detach-host',
    restorePolicy: 'descriptor',
  },
};

describe('F307 surface focus mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
  });

  it('keeps the owner DOM mounted while hiding and restoring the pane chrome', () => {
    const enter = vi.fn();
    const exit = vi.fn();
    const owner = <div data-testid="chess-owner">棋盘</div>;

    act(() =>
      root.render(
        <F307SurfacePane surface={SURFACE} focusMode={false} onEnterFocusMode={enter} onExitFocusMode={exit}>
          {owner}
        </F307SurfacePane>,
      ),
    );
    const ownerNode = container.querySelector('[data-testid="chess-owner"]');
    const entry = container.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-enter"]');
    expect(entry?.textContent).toContain('专注');
    act(() => entry?.click());
    expect(enter).toHaveBeenCalledOnce();

    act(() =>
      root.render(
        <F307SurfacePane surface={SURFACE} focusMode onEnterFocusMode={enter} onExitFocusMode={exit}>
          {owner}
        </F307SurfacePane>,
      ),
    );

    expect(container.querySelector('[data-testid="f307-surface-chrome"]')).toBeNull();
    expect(container.querySelector('[data-testid="chess-owner"]')).toBe(ownerNode);
    const exitButton = container.querySelector<HTMLButtonElement>('[data-testid="workspace-focus-exit"]');
    expect(exitButton?.textContent).toContain('退出专注');
    act(() => exitButton?.click());
    expect(exit).toHaveBeenCalledOnce();
  });

  it('lets v2 tool chrome own the title and actions without an extra surface header', () => {
    writeShellPresentation('v2');
    const file = { ...SURFACE, type: 'file' as const, renderer: 'file-preview' as const, title: 'guide.md' };
    const owner = <div data-testid="original-file">guide.md 正文</div>;
    act(() => root.render(<F307SurfacePane surface={file}>{owner}</F307SurfacePane>));
    const original = container.querySelector('[data-testid="original-file"]');
    expect(container.querySelector('[data-testid="f307-surface-chrome"]')).toBeNull();
    act(() => writeShellPresentation('classic'));
    expect(container.querySelector('[data-testid="f307-surface-chrome"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="original-file"]')).toBe(original);
  });

  it('projects a document artifact host control into its one file toolbar without a second title row', () => {
    writeShellPresentation('v2');
    const fullWindow = vi.fn();
    const surface = createArtifactSurface({
      threadId: 't',
      artifact: {
        type: 'file',
        name: '中文稿.md',
        url: '/uploads/document.md',
        mime: 'text/markdown',
        catId: null,
        createdAt: 1,
        sourceMessageId: 'm',
        publicationItem: { kind: 'content-block', index: 1 },
      },
    });
    act(() =>
      root.render(
        <F307SurfacePane surface={surface} onToggleArtifactWorkFullWindow={fullWindow}>
          <FileToolbar source={{ kind: 'url', url: '/uploads/document.md' }} filename="中文稿.md" />
        </F307SurfacePane>,
      ),
    );
    expect(container.querySelector('[data-testid="f307-surface-chrome"]')).toBeNull();
    const toolbar = container.querySelector('[data-testid="content-file-toolbar"]');
    const control = toolbar?.querySelector<HTMLButtonElement>('[data-testid="f307-artifact-enter-full-window"]');
    expect(control).not.toBeNull();
    act(() => control?.click());
    expect(fullWindow).toHaveBeenCalledOnce();
  });

  it('closes shared menus while a document tab is retained out of view and does not reopen them on return', async () => {
    function Reader({ visible }: { visible: boolean }) {
      return (
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <FileToolbar source={{ kind: 'url', url: 'https://external.test/file.md' }} filename="file.md" />
        </WorkspaceSurfaceVisibilityProvider>
      );
    }
    await act(async () => root.render(<Reader visible />));
    const row = container.querySelector('[data-testid="content-file-toolbar"]');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => root.render(<Reader visible={false} />));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="content-file-toolbar"]')).toBe(row);
    await act(async () => root.render(<Reader visible />));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('retains the first controlled comment while promoting its original preview', () => {
    const file = { ...SURFACE, type: 'file' as const, renderer: 'file-preview' as const };
    useF307ExperienceWorkbenchStore.setState({
      layout: { ...createInitialWorkbenchState([file]), previewSurfaceId: file.id },
      hydrated: true,
    });
    const received = vi.fn();
    const order: string[] = [];
    function Comment() {
      const [value, setValue] = useState('');
      return (
        <textarea
          value={value}
          onInput={() => order.push('owner-input')}
          onChange={(event) => {
            received(event.currentTarget.value);
            setValue(event.currentTarget.value);
          }}
        />
      );
    }
    function Preview() {
      const layout = useF307ExperienceWorkbenchStore((state) => state.layout);
      return (
        <F307SurfacePane surface={layout.surfaces[0]}>
          <Comment />
        </F307SurfacePane>
      );
    }
    act(() => root.render(<Preview />));
    const comment = container.querySelector('textarea');
    if (!comment) throw new Error('comment missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    const unsubscribe = useF307ExperienceWorkbenchStore.subscribe((state, previous) => {
      if (previous.layout.previewSurfaceId && !state.layout.previewSurfaceId) order.push('promoted');
    });
    act(() => {
      setter?.call(comment, '第一处改具体些。');
      comment.dispatchEvent(new Event('input', { bubbles: true }));
    });
    unsubscribe();
    expect(order).toEqual(['owner-input', 'promoted']);
    expect(received).toHaveBeenCalledWith('第一处改具体些。');
    expect(comment.value).toBe('第一处改具体些。');
    expect(container.querySelector('textarea')).toBe(comment);
    expect(useF307ExperienceWorkbenchStore.getState().layout.previewSurfaceId).toBeNull();
    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]).toBe(file);
  });
});
