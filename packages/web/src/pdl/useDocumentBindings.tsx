'use client';
import type { ContentModificationSelection, ContextAttachment } from '@cat-cafe/shared';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceContentReview } from '@/components/workbench/content-review/useWorkspaceContentReview';
import { useWorkspaceFileQuotes } from '@/components/workbench/content-review/useWorkspaceFileQuotes';
import { workspaceReviewRequestSource } from '@/components/workbench/content-review/workspace-modification-source';
import { useWorkspaceListenMode } from '@/components/workspace/useWorkspaceListenMode';
import { workspaceFileQuoteAttachment } from '@/components/workspace/workspace-file-quote';
import type { FileData } from '@/hooks/useWorkspace';
import { documentListenController } from '@/services/DocumentListenController';
import { useListenModeStore } from '@/stores/listenModeStore';
import { write } from './owner-api';

interface Snapshot {
  owner: ReturnType<typeof useWorkspaceContentReview>;
  quotes: ReturnType<typeof useWorkspaceFileQuotes>;
  listen: ReturnType<typeof useWorkspaceListenMode>;
  session: ReturnType<typeof useListenModeStore.getState>['session'];
  worktreeId: string;
  file: FileData;
}
export function DocumentOwnerBinding({
  worktreeId,
  file,
  generation,
  changed,
}: {
  worktreeId: string;
  file: FileData;
  generation: number;
  changed: (snapshot: Snapshot) => void;
}) {
  const owner = useWorkspaceContentReview({ worktreeId, path: file.path }, generation);
  const quotes = useWorkspaceFileQuotes(
    { worktreeId, path: file.path },
    owner.view?.review.source.revision ?? `sha256:${file.sha256}`,
    generation,
  );
  const listen = useWorkspaceListenMode({
    file,
    openFilePath: file.path,
    worktreeId,
    enabled: true,
    readGeneration: generation,
  });
  const session = useListenModeStore((s) => s.session);
  useLayoutEffect(() => {
    // A read in flight retains the last complete published document.
    if ((!owner.view && !owner.error) || quotes.state === 'loading') return;
    changed({ owner, quotes, listen, session, worktreeId, file });
  });
  return null;
}
export function useDocumentBindings(
  fields: Record<string, unknown>,
  opened: { worktreeId: string; file: FileData } | null,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [, publish] = useState(0);
  const current =
    snapshot &&
    opened &&
    snapshot.worktreeId === opened.worktreeId &&
    snapshot.file.path === opened.file.path &&
    snapshot.file.sha256 === opened.file.sha256
      ? snapshot
      : null;
  const quote = useRef<Extract<ContextAttachment, { kind: 'quote' }>>();
  const changed = useCallback(
    (next: Snapshot) =>
      setSnapshot((old) =>
        old?.worktreeId === next.worktreeId &&
        old?.file === next.file &&
        old?.owner.view === next.owner.view &&
        old?.owner.error === next.owner.error &&
        old?.owner.busy === next.owner.busy &&
        old?.quotes.quotes === next.quotes.quotes &&
        old?.quotes.state === next.quotes.state &&
        old?.quotes.nextCursor === next.quotes.nextCursor &&
        JSON.stringify(old?.listen.cache) === JSON.stringify(next.listen.cache) &&
        old?.listen.active === next.listen.active &&
        old?.listen.activeCacheKey === next.listen.activeCacheKey &&
        old?.listen.activeAnchor === next.listen.activeAnchor &&
        old?.listen.previousVersion === next.listen.previousVersion &&
        old?.session === next.session
          ? old
          : next,
      ),
    [],
  );
  const selected = useRef<{ work: string; quote: string; reviewId: string; revision: string } | null>(null);
  const resolve = async (text: string) => {
    const view = current?.owner.view;
    if (!view || view.review.source.kind !== 'text') throw new Error('文件来源尚未确认');
    const result = await write<{ selection: ContentModificationSelection }>('/api/content-modifications/selection', {
      source: workspaceReviewRequestSource(view),
      quote: text,
    });
    if (result.selection.kind !== 'text_quote') throw new Error('正文选区来源不一致');
    return result.selection;
  };
  const action = async (name: string, args: Record<string, string>): Promise<unknown> => {
    const s = current,
      view = s?.owner.view;
    if (name === 'workTextAnnotate') {
      await resolve(args.quote);
      selected.current = {
        work: args.id,
        quote: args.quote,
        reviewId: view!.review.reviewId,
        revision: view!.review.source.revision,
      };
      publish((n) => n + 1);
      return true;
    }
    if (name === 'workTextSave') {
      if (
        !s ||
        !selected.current ||
        selected.current.reviewId !== view?.review.reviewId ||
        selected.current.revision !== view.review.source.revision
      )
        throw new Error('请重新选择正文');
      if (!(await s.owner.addOpinion(args.body, { kind: 'text_quote', quote: selected.current.quote })))
        throw new Error('正文批注未保存');
      selected.current = null;
      publish((n) => n + 1);
      return true;
    }
    if (name === 'workTextReply') {
      if (!s || !view) throw new Error('正文尚未读取');
      if (
        !(await s.owner.act({
          kind: 'reply',
          annotationId: args.id,
          replyId: crypto.randomUUID(),
          body: String(fields[`review-reply-${args.id}`] ?? args.v),
        }))
      )
        throw new Error('回复未保存');
      fields[`review-reply-${args.id}`] = '';
      return true;
    }
    if (name === 'workspaceAnnotation') {
      if (
        !s ||
        !(await s.owner.act({
          kind: 'set_annotation_state',
          annotationId: args.id,
          state: args.v as 'open' | 'resolved',
        }))
      )
        throw new Error('批注状态未保存');
      return true;
    }
    if (name === 'documentListen') {
      if (!s) throw new Error('正文尚未读取');
      if (args.op === 'start') s.listen.start();
      else if (s.listen.active) documentListenController.togglePlayback();
      return true;
    }
    if (name === 'documentQuoteResolve') {
      if (!s || !view || view.review.source.kind !== 'text') throw new Error('正文来源尚未确认');
      const selection = await resolve(args.quote);
      quote.current = workspaceFileQuoteAttachment({
        text: selection.quote,
        comment: '',
        path: s.file.path,
        worktreeId: s.worktreeId,
        revision: view.review.source.revision,
        selectionStart: selection.start,
        selectionEnd: selection.end,
      }) as Extract<ContextAttachment, { kind: 'quote' }>;
      publish((n) => n + 1);
      return quote.current;
    }
    if (name === 'refresh' && args.k.startsWith('document-review:')) {
      await s?.owner.refreshSource();
      s?.quotes.reload();
      return true;
    }
    return false;
  };
  const rawData = useMemo(
    () => ({
      selection: selected.current,
      quote: quote.current,
      snapshot: snapshot && {
        file: snapshot.file,
        worktreeId: snapshot.worktreeId,
        review: { view: snapshot.owner.view, error: snapshot.owner.error, busy: snapshot.owner.busy },
        quotes: {
          quotes: snapshot.quotes.quotes,
          state: snapshot.quotes.state,
          nextCursor: snapshot.quotes.nextCursor,
        },
        listen: {
          cache: snapshot.listen.cache,
          active: snapshot.listen.active,
          activeCacheKey: snapshot.listen.activeCacheKey,
          activeAnchor: snapshot.listen.activeAnchor,
          previousVersion: snapshot.listen.previousVersion,
        },
        session: snapshot.session,
      },
    }),
    [selected.current, quote.current, snapshot],
  );
  return {
    action,
    changed,
    data: rawData,
  };
}
