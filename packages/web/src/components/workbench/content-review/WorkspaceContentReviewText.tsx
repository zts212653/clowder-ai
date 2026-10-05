import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveSelectionAnnotationAction } from '@/components/LiveSelectionAnnotationAction';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useWorkspaceListenMode } from '@/components/workspace/useWorkspaceListenMode';
import { WorkspaceListenActions } from '@/components/workspace/WorkspaceListenActions';
import { addWorkspaceFileQuoteToChat } from '@/components/workspace/workspace-file-quote';
import { useTextSelectionAction } from '@/hooks/useTextSelectionAction';
import { maskLeadingMarkdownFrontmatter } from '@/lib/listen-mode/markdown-sentences';
import { useChatStore } from '@/stores/chatStore';
import { LISTEN_RETURN_DOCUMENT_EVENT } from '@/stores/listenModeStore';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';

/** 1-based line range of a raw-text span; only meaningful where the rendered text is the raw text. */
function rawLineRange(text: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  return {
    lineStart: text.slice(0, start).split('\n').length,
    lineEnd: text.slice(0, Math.max(start, end - 1)).split('\n').length,
  };
}

export function WorkspaceContentReviewText({
  text,
  markdown,
  onQuoteSelected,
  locator,
  scrollToLine,
  revision,
}: {
  readonly text: string;
  readonly markdown: boolean;
  readonly onQuoteSelected: (quote: string) => void;
  readonly locator: { worktreeId: string; path: string };
  readonly scrollToLine?: number | null;
  readonly revision: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const visible = useWorkspaceSurfaceVisibility();
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const selectionKey = `${locator.worktreeId}:${locator.path}:${revision}`;
  // The same selection → in-place card → chat annotation chip as the F063 file viewer (CVO095/098).
  const selection = useTextSelectionAction(container, visible, selectionKey, 'container');
  const [following, setFollowing] = useState<'auto' | 'paused' | 'requested'>('auto');
  const file = useMemo(
    () => ({
      path: locator.path,
      content: text,
      sha256: revision.replace(/^sha256:/, ''),
      mime: markdown ? 'text/markdown' : 'text/plain',
      size: new TextEncoder().encode(text).length,
      truncated: false,
    }),
    [locator.path, text, revision, markdown],
  );
  const listen = useWorkspaceListenMode({
    file,
    openFilePath: locator.path,
    worktreeId: locator.worktreeId,
    enabled: markdown,
  });
  const followCurrentSentence = following === 'requested' || (following === 'auto' && !scrollToLine);
  useEffect(() => {
    const reveal = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (
        detail &&
        typeof detail === 'object' &&
        'cacheKey' in detail &&
        'worktreeId' in detail &&
        detail.cacheKey === listen.cacheKey &&
        detail.worktreeId === locator.worktreeId &&
        listen.active
      )
        setFollowing('requested');
    };
    window.addEventListener(LISTEN_RETURN_DOCUMENT_EVENT, reveal);
    return () => window.removeEventListener(LISTEN_RETURN_DOCUMENT_EVENT, reveal);
  }, [listen.cacheKey, listen.active, locator.worktreeId]);
  useEffect(() => {
    if (!visible || !followCurrentSentence || !listen.activeAnchor) return;
    const sentence = [
      ...(container.current?.querySelectorAll<HTMLElement>('[data-listen-sentence-anchor]') ?? []),
    ].find((item) => item.dataset.listenSentenceAnchor === listen.activeAnchor);
    sentence?.scrollIntoView?.({ block: 'center' });
  }, [listen.activeAnchor, followCurrentSentence, visible]);
  useEffect(() => {
    if (!scrollToLine || !visible) return;
    const exact = container.current?.querySelector<HTMLElement>(`[data-workspace-link-line="${scrollToLine}"]`);
    const lines = [...(container.current?.querySelectorAll<HTMLElement>('[data-source-line]') ?? [])];
    const target = exact ?? lines.filter((node) => Number(node.dataset.sourceLine) <= scrollToLine).at(-1) ?? lines[0];
    target?.scrollIntoView?.({ block: 'center' });
  }, [scrollToLine, text, visible]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={container}
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-cafe-subtle bg-cafe-white p-4"
        data-testid="workspace-content-review-text"
        onWheel={() => setFollowing('paused')}
        onTouchStart={() => setFollowing('paused')}
        onPointerDown={() => setFollowing('paused')}
        onMouseUp={() => {
          const quote = window.getSelection()?.toString().trim() ?? '';
          if (quote) onQuoteSelected(quote);
        }}
      >
        {markdown && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <WorkspaceListenActions
              active={listen.active}
              cache={listen.cache}
              hasSentences={listen.sentences.length > 0}
              onCancelCache={listen.cancelCache}
              onStartCache={listen.startCache}
              onStartListen={() => {
                setFollowing('requested');
                listen.start();
              }}
            />
            {listen.activeAnchor && !followCurrentSentence && (
              <button
                type="button"
                className="rounded border border-cafe px-2 py-1 text-xs"
                onClick={() => setFollowing('requested')}
              >
                回到当前句
              </button>
            )}
            {listen.previousVersion && (
              <p role="status" className="text-xs text-cafe-muted">
                听读的是此文档的旧版本；当前正文已更新。
              </p>
            )}
          </div>
        )}
        {markdown ? (
          <MarkdownContent
            content={maskLeadingMarkdownFrontmatter(text)}
            disableCommandPrefix
            sourcePath={locator.path}
            worktreeId={locator.worktreeId}
            basePath={locator.path.split('/').slice(0, -1).join('/')}
            listenSentences={listen.active ? listen.sentences : undefined}
            activeListenAnchor={listen.activeAnchor}
            onListenSentenceStart={
              listen.active
                ? (index) => {
                    setFollowing('requested');
                    listen.start(index);
                  }
                : undefined
            }
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-cafe">
            {text.split('\n').map((line, index, lines) => (
              <span key={index} data-source-line={index + 1}>
                {line}
                {index + 1 < lines.length ? '\n' : ''}
              </span>
            ))}
          </pre>
        )}
      </div>
      <LiveSelectionAnnotationAction
        action={selection}
        resetKey={selectionKey}
        positionMode="absolute"
        actionTestId="workspace-content-review-text-add-to-chat"
        onSave={(action, comment) =>
          addWorkspaceFileQuoteToChat(currentThreadId, {
            text: action.text,
            comment,
            path: locator.path,
            worktreeId: locator.worktreeId,
            language: markdown ? 'markdown' : null,
            selectionStart: action.selectionStart,
            selectionEnd: action.selectionEnd,
            // The <pre> shows the raw text itself, so its offsets are real file lines; rendered Markdown is not.
            ...(!markdown && action.selectionStart !== undefined && action.selectionEnd !== undefined
              ? rawLineRange(text, action.selectionStart, action.selectionEnd)
              : {}),
          })
        }
      />
    </div>
  );
}
