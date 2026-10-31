import type { WorkspaceFileQuotePage, WorkspaceFileQuoteReference } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { checked, ModificationHttpError } from '@/components/content-review/modification-http';
import { FOCUS_REFRESH_MS, PROJECTION_EVENT } from '@/components/content-review/useMediaMessageRequests';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type ReadState = 'loading' | 'ready' | 'changed' | 'failed' | 'hidden';

/** File-side references come from the message owner, not a new annotation ledger. */
export function useWorkspaceFileQuotes(
  locator: { worktreeId: string; path: string },
  revision: string,
  visible: boolean,
) {
  const { worktreeId, path } = locator;
  const scope = JSON.stringify([worktreeId, path, revision]);
  const [view, setView] = useState<{
    scope: string;
    quotes: readonly WorkspaceFileQuoteReference[];
    state: ReadState;
    nextCursor?: string;
  }>({ scope, quotes: [], state: 'loading' });
  const sequence = useRef(0),
    lastReadAt = useRef(0);
  // Callback quotes can arrive in an existing bubble. Observe their metadata, never streaming body tokens.
  const frontier = useChatStore((store) =>
    JSON.stringify(
      store.messages.flatMap((message) => {
        const quotes =
          message.contentBlocks?.flatMap((block) =>
            block.type === 'context_attachment' &&
            block.attachment.kind === 'quote' &&
            block.attachment.source.kind === 'workspace_file' &&
            block.attachment.source.worktreeId === worktreeId &&
            block.attachment.source.path === path
              ? [block.attachment]
              : [],
          ) ?? [];
        return quotes.length ? [[message.id, message.extra?.recall ?? null, quotes]] : [];
      }),
    ),
  );
  const read = useCallback(
    async (before?: string) => {
      const ticket = ++sequence.current;
      lastReadAt.current = Date.now();
      setView((current) => ({
        scope,
        quotes: before && current.scope === scope ? current.quotes : [],
        state: 'loading',
      }));
      try {
        const query = new URLSearchParams({
          worktreeId,
          path,
          expectedSourceRevision: revision,
          ...(before ? { before } : {}),
        });
        const page = await checked<WorkspaceFileQuotePage>(
          await apiFetch(`/api/workspace/file-quotes?${query}`, undefined, { afterCurrentGet: true }),
        );
        if (ticket !== sequence.current) return;
        if (page.sourceRevision !== revision) {
          setView({ scope, quotes: [], state: 'changed' });
          return;
        }
        if (!Array.isArray(page.quotes)) throw new Error('Invalid file quote page');
        setView((current) => ({
          scope,
          quotes: before && current.scope === scope ? [...page.quotes, ...current.quotes] : page.quotes,
          nextCursor: page.nextCursor,
          state: 'ready',
        }));
      } catch (error) {
        if (ticket !== sequence.current) return;
        setView({
          scope,
          quotes: [],
          state:
            error instanceof ModificationHttpError && error.status === 409
              ? 'changed'
              : error instanceof ModificationHttpError && [401, 403, 404, 410].includes(error.status)
                ? 'hidden'
                : 'failed',
        });
      }
    },
    [worktreeId, path, revision, scope],
  );
  useEffect(() => {
    sequence.current += 1;
    setView({ scope, quotes: [], state: 'loading' });
    if (!visible) return;
    void read();
    const refresh = () => void read();
    const hint = () => {
      if (Date.now() - lastReadAt.current >= FOCUS_REFRESH_MS) refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') hint();
    };
    window.addEventListener(PROJECTION_EVENT, refresh);
    window.addEventListener('focus', hint);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      sequence.current += 1;
      window.removeEventListener(PROJECTION_EVENT, refresh);
      window.removeEventListener('focus', hint);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read, visible, frontier, scope]);
  const current = view.scope === scope ? view : { scope, quotes: [], state: 'loading' as const, nextCursor: undefined };
  return {
    quotes: current.quotes,
    state: current.state,
    nextCursor: current.nextCursor,
    reload: () => read(),
    loadMore: () => (current.nextCursor ? read(current.nextCursor) : Promise.resolve()),
  };
}
