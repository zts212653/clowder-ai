import { Rnd } from 'react-rnd';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { PresentationSurfaceContent } from '@/stores/chat-types';

/**
 * F226 — pure presentational floating window for the presentation surface.
 * Props in, JSX out (no store / no effects) so it is SSR-testable. The container
 * `FloatingPresentationSurfaceHost` wires it to the store + file fetch.
 */
export interface PresentationFloatViewProps {
  content: PresentationSurfaceContent;
  pos: { x: number; y: number };
  size: { width: number; height: number };
  minimized: boolean;
  /** F226 尺寸快捷: 一键适配 PPT 的放大态 */
  maximized: boolean;
  /** fetched text content; null = still loading (image kind ignores this) */
  fileContent: string | null;
  rawSrc: string;
  onDockBack: () => void;
  onClose: () => void;
  onMinimize: (minimized: boolean) => void;
  onDragStop: (pos: { x: number; y: number }) => void;
  onResizeStop: (pos: { x: number; y: number }, size: { width: number; height: number }) => void;
  onToggleMaximize: () => void;
}

export function PresentationFloatView({
  content: c,
  pos,
  size,
  minimized,
  maximized,
  fileContent,
  rawSrc,
  onDockBack,
  onClose,
  onMinimize,
  onDragStop,
  onResizeStop,
  onToggleMaximize,
}: PresentationFloatViewProps) {
  // Minimized bar — pin prefix + filename (烁烁 P2-4)
  if (minimized) {
    return (
      <Rnd
        key="f226-float-minimized"
        default={{ x: pos.x, y: pos.y, width: 260, height: 36 }}
        enableResizing={false}
        bounds="window"
        tabIndex={-1}
        className="z-[35]"
        onDragStop={(_e, d) => onDragStop({ x: d.x, y: d.y })}
      >
        <div className="flex h-9 items-center gap-2 rounded-lg border-2 border-[var(--bg-owner)] bg-cafe-surface-primary px-3 shadow-lg ring-1 ring-[var(--console-border-soft)]">
          <span className="text-xs" aria-hidden>
            📌
          </span>
          <span className="flex-1 truncate text-xs text-cafe-text-primary" title={c.filePath}>
            {c.title}
          </span>
          <button
            type="button"
            onClick={() => onMinimize(false)}
            title="还原浮窗"
            className="text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          >
            ▢
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭浮窗"
            className="text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          >
            ×
          </button>
        </div>
      </Rnd>
    );
  }

  return (
    <Rnd
      key={`f226-float-full-${maximized ? 'max' : 'normal'}`}
      default={{ x: pos.x, y: pos.y, width: size.width, height: size.height }}
      minWidth={280}
      minHeight={200}
      bounds="window"
      dragHandleClassName="f226-float-drag-handle"
      tabIndex={-1}
      className="z-[35]"
      onDragStop={(_e, d) => onDragStop({ x: d.x, y: d.y })}
      onResizeStop={(_e, _dir, ref, _delta, p) =>
        onResizeStop({ x: p.x, y: p.y }, { width: ref.offsetWidth, height: ref.offsetHeight })
      }
    >
      {/* 暖色边框区分 F195 transcript 蓝 (烁烁 P2-3) */}
      <div
        tabIndex={-1}
        className="f226-float-in flex h-full flex-col rounded-lg border-2 border-[var(--bg-owner)] bg-cafe-surface-primary shadow-2xl ring-1 ring-[var(--console-border-soft)]"
      >
        {/* Header — drag handle (云端 P2) + 双击适配 PPT (F226 尺寸快捷)。body 仍可选可点 */}
        <div
          onDoubleClick={onToggleMaximize}
          className="f226-float-drag-handle flex items-center gap-2 border-b border-cafe-border px-3 py-2 cursor-move select-none"
        >
          <span className="text-xs" aria-hidden>
            📌
          </span>
          <span className="flex-1 truncate text-sm font-medium text-cafe-text-primary" title={c.filePath}>
            {c.title}
            {c.worktreeId && <span className="ml-1 text-micro text-cafe-text-muted">· {c.worktreeId}</span>}
          </span>
          <button
            type="button"
            onClick={onToggleMaximize}
            title={maximized ? '还原尺寸' : '适配 PPT — 一键放大居中看清（也可双击标题栏）'}
            className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          >
            {maximized ? '⤡' : '⤢'}
          </button>
          <button
            type="button"
            onClick={onDockBack}
            title="回坞 — 讲稿收回右侧 workspace"
            className="rounded px-1.5 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          >
            回坞
          </button>
          <button
            type="button"
            onClick={() => onMinimize(true)}
            title="最小化"
            className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          >
            –
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭浮窗"
            className="rounded px-1 py-0.5 text-xs text-cafe-text-muted hover:text-cafe-text-primary"
          >
            ×
          </button>
        </div>

        {/* Body — read-only viewer: image / rendered markdown / raw text */}
        <div className="flex-1 overflow-auto p-3">
          {c.fileKind === 'image' ? (
            <div className="flex h-full items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={rawSrc} alt={c.title} className="max-w-full max-h-full object-contain rounded" />
            </div>
          ) : fileContent !== null ? (
            c.fileKind === 'markdown' && c.renderMode === 'rendered' ? (
              <MarkdownContent
                content={fileContent}
                disableCommandPrefix
                worktreeId={c.worktreeId ?? undefined}
                basePath={c.filePath.split('/').slice(0, -1).join('/')}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-cafe-text-primary">
                {fileContent}
              </pre>
            )
          ) : (
            <p className="mt-8 text-center text-xs text-cafe-text-muted">加载 {c.title} …</p>
          )}
        </div>
      </div>
    </Rnd>
  );
}
