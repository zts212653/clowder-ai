import type { SignalArticleStatus, StudyMeta } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { getThreadHref } from '@/components/ThreadSidebar/thread-navigation';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import type { SignalArticleDetail } from '@/utils/signals-api';
import { fetchStudyMeta, linkSignalThread, unlinkSignalThread } from '@/utils/signals-api';
import { SignalTierBadge } from './SignalTierBadge';
import { StudyFoldArea } from './StudyFoldArea';

interface SignalArticleDetailProps {
  readonly article: SignalArticleDetail | null;
  readonly isLoading: boolean;
  readonly onStatusChange: (articleId: string, status: SignalArticleStatus) => Promise<void>;
  readonly onTagsChange: (articleId: string, tags: readonly string[]) => Promise<void>;
  readonly onNoteChange?: (articleId: string, note: string) => Promise<void>;
  readonly onDelete?: (articleId: string) => Promise<void>;
  readonly collections?: readonly { id: string; name: string }[] | undefined;
  readonly onAddToCollection?: (collectionId: string) => Promise<void>;
  readonly onCreateCollection?: (name: string) => Promise<void>;
  readonly onCollectionChanged?: () => void;
}

function formatDate(input: string): string {
  const value = Date.parse(input);
  if (Number.isNaN(value)) {
    return input;
  }
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SignalArticleDetail({
  article,
  isLoading,
  onStatusChange,
  onTagsChange,
  onNoteChange,
  onDelete,
  collections,
  onAddToCollection,
  onCreateCollection,
  onCollectionChanged,
}: SignalArticleDetailProps) {
  const [pendingTag, setPendingTag] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandContent, setExpandContent] = useState(false);
  const [enrichedContent, setEnrichedContent] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const pendingTagInputRef = useRef<HTMLInputElement>(null);
  const normalizedPendingTag = pendingTag.trim();
  const ime = useIMEGuard();

  // Sync noteText when article changes
  const prevArticleId = useRef<string | null>(null);
  if (article && article.id !== prevArticleId.current) {
    prevArticleId.current = article.id;
    setNoteText(article.note ?? '');
    setNoteOpen(!!article.note);
    setConfirmDelete(false);
  }

  const saveNote = useCallback(async () => {
    if (!article || !onNoteChange) return;
    const trimmed = noteText.trim();
    if (trimmed === (article.note ?? '')) return;
    await onNoteChange(article.id, trimmed);
  }, [article, noteText, onNoteChange]);

  const handleDelete = useCallback(async () => {
    if (!article || !onDelete) return;
    await onDelete(article.id);
  }, [article, onDelete]);

  const [studyMeta, setStudyMeta] = useState<StudyMeta | null>(null);
  useEffect(() => {
    if (!article) {
      setStudyMeta(null);
      return;
    }
    let cancelled = false;
    fetchStudyMeta(article.id)
      .then((meta) => {
        if (!cancelled) setStudyMeta(meta);
      })
      .catch(() => {
        if (!cancelled) setStudyMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [article?.id, article]);

  const handleLinkThread = useCallback(
    async (threadId: string) => {
      if (!article) return;
      const meta = await linkSignalThread(article.id, threadId);
      setStudyMeta(meta);
    },
    [article],
  );

  const handleUnlinkThread = useCallback(
    async (threadId: string) => {
      if (!article) return;
      const meta = await unlinkSignalThread(article.id, threadId);
      setStudyMeta(meta);
    },
    [article],
  );

  const refreshStudyMeta = useCallback(() => {
    if (!article) return;
    fetchStudyMeta(article.id)
      .then(setStudyMeta)
      .catch(() => {});
  }, [article]);

  const handleCollectionAdd = useCallback(
    async (collectionId: string) => {
      if (!onAddToCollection) return;
      await onAddToCollection(collectionId);
      refreshStudyMeta();
      onCollectionChanged?.();
    },
    [onAddToCollection, refreshStudyMeta, onCollectionChanged],
  );

  const handleCollectionCreate = useCallback(
    async (name: string) => {
      if (!onCreateCollection) return;
      await onCreateCollection(name);
      refreshStudyMeta();
      onCollectionChanged?.();
    },
    [onCreateCollection, refreshStudyMeta, onCollectionChanged],
  );

  // Resolve or create a study thread, then navigate
  const [discussLoading, setDiscussLoading] = useState(false);
  const navigateToDiscuss = useCallback(async () => {
    if (!article || discussLoading) return;
    setDiscussLoading(true);
    try {
      const res = await apiFetch(`/api/signals/articles/${encodeURIComponent(article.id)}/discuss`, {
        method: 'POST',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { threadId: string };
      const query = new URLSearchParams({ signal: article.id, source: article.source });
      window.location.href = `${getThreadHref(data.threadId)}?${query.toString()}`;
    } finally {
      setDiscussLoading(false);
    }
  }, [article, discussLoading]);

  const handleEnrich = useCallback(async () => {
    if (!article || enriching) return;
    if (expandContent) {
      setExpandContent(false);
      return;
    }
    // Always expand existing content immediately
    setExpandContent(true);
    if (enrichedContent) return;
    // Try enrichment in background — failure doesn't block reading
    setEnriching(true);
    setEnrichError(null);
    try {
      const res = await apiFetch(`/api/signals/articles/${encodeURIComponent(article.id)}/enrich`, {
        method: 'POST',
      });
      if (!res.ok) {
        setEnrichError('全文抓取失败');
        return;
      }
      const data = (await res.json()) as { enriched: boolean; reason?: string; contentLength?: number };
      if (data.enriched) {
        const detail = await apiFetch(`/api/signals/articles/${encodeURIComponent(article.id)}`);
        if (detail.ok) {
          const body = (await detail.json()) as { article: { content?: string } };
          setEnrichedContent(body.article.content || null);
        }
      } else if (data.reason === 'fetch_failed') {
        setEnrichError('无法访问原始页面');
      }
    } finally {
      setEnriching(false);
    }
  }, [article, enriching, expandContent, enrichedContent]);

  const addPendingTag = useCallback(async () => {
    if (!article) {
      return;
    }
    const candidateTag =
      normalizedPendingTag.length > 0 ? normalizedPendingTag : (pendingTagInputRef.current?.value.trim() ?? '');
    if (candidateTag.length === 0) {
      return;
    }
    const hasExisting = article.tags.some((tag) => tag.toLowerCase() === candidateTag.toLowerCase());
    if (hasExisting) {
      setPendingTag('');
      return;
    }
    await onTagsChange(article.id, [...article.tags, candidateTag]);
    setPendingTag('');
    if (pendingTagInputRef.current) {
      pendingTagInputRef.current.value = '';
    }
  }, [article, normalizedPendingTag, onTagsChange]);

  if (isLoading) {
    return (
      <aside className="rounded-xl bg-[var(--console-card-bg)] p-6 text-sm text-cafe-secondary shadow-sm">
        正在加载文章详情...
      </aside>
    );
  }

  if (!article) {
    return (
      <aside className="rounded-xl border border-dashed border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-6 text-sm text-cafe-secondary">
        选择一篇文章查看详情。
      </aside>
    );
  }

  return (
    <aside className="rounded-xl bg-[var(--console-card-bg)] p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SignalTierBadge tier={article.tier} />
        <span className="rounded bg-[var(--console-field-bg)] px-2 py-0.5 text-xs font-medium text-cafe-secondary">
          {article.status}
        </span>
      </div>
      <h2 className="mt-2 text-lg font-semibold text-cafe-black">{article.title}</h2>
      <p className="mt-1 text-xs text-cafe-secondary">
        {article.source} · {formatDate(article.fetchedAt)}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-[var(--console-border-soft)] px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
        >
          打开原文 ↗
        </a>
        <button
          type="button"
          onClick={() => void navigateToDiscuss()}
          disabled={discussLoading}
          className="rounded-md border border-opus-light px-3 py-1.5 text-xs text-opus-dark hover:bg-opus-bg disabled:opacity-50"
        >
          {discussLoading ? '正在创建讨论...' : '在对话中讨论'}
        </button>
      </div>
      {article.summary && (
        <section className="mt-4 rounded-lg bg-[var(--console-field-bg)] p-3">
          <h3 className="text-xs font-semibold text-cafe-black">AI 摘要</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-cafe-black">{article.summary}</p>
        </section>
      )}
      <StudyFoldArea
        articleId={article.id}
        studyMeta={studyMeta}
        onStartStudy={() => void navigateToDiscuss()}
        onDiscuss={() => void navigateToDiscuss()}
        discussLoading={discussLoading}
        onLinkThread={handleLinkThread}
        onUnlinkThread={handleUnlinkThread}
        collections={collections}
        onAddToCollection={handleCollectionAdd}
        onCreateCollection={handleCollectionCreate}
        onStudyMetaRefresh={refreshStudyMeta}
      />
      <section className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-cafe-secondary">正文</h3>
          <div className="flex items-center gap-2">
            {enrichError && <span className="text-xs text-red-500">{enrichError}</span>}
            <button
              type="button"
              onClick={handleEnrich}
              disabled={enriching}
              className="text-xs text-opus-dark hover:underline disabled:opacity-50"
            >
              {enriching ? '正在获取全文…' : expandContent ? '收起' : '展开阅读'}
            </button>
          </div>
        </div>
        <div
          className={`mt-1 overflow-y-auto rounded-lg bg-[var(--console-field-bg)] p-3 text-sm text-cafe-black ${expandContent ? '' : 'max-h-[300px]'}`}
        >
          <MarkdownContent content={enrichedContent || article.content || '（无正文）'} />
        </div>
      </section>
      <section className="mt-4">
        <h3 className="text-xs font-semibold text-cafe-secondary">标签</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {article.tags.length === 0 ? (
            <span className="text-xs text-cafe-secondary">暂无标签</span>
          ) : (
            article.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-codex-light bg-codex-bg px-2 py-0.5 text-xs text-codex-dark"
              >
                {tag}
              </span>
            ))
          )}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            ref={pendingTagInputRef}
            value={pendingTag}
            onChange={(event) => setPendingTag(event.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(event) => {
              if (ime.isComposing()) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void addPendingTag();
              }
            }}
            placeholder="添加标签"
            className="flex-1 rounded-md border border-[var(--console-border-soft)] px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={() => void addPendingTag()}
            className="rounded-md border border-codex-light px-2.5 py-1.5 text-xs text-codex-dark hover:bg-codex-bg"
          >
            添加标签
          </button>
        </div>
      </section>
      {onNoteChange && (
        <section className="mt-4">
          <button
            type="button"
            onClick={() => setNoteOpen((prev) => !prev)}
            className="flex items-center gap-1 text-xs font-semibold text-cafe-secondary"
          >
            <span>{noteOpen ? '▾' : '▸'}</span>
            <span>备注{article.note ? ' ✎' : ''}</span>
          </button>
          {noteOpen && (
            <div className="mt-2">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onBlur={() => void saveNote()}
                placeholder="写下你的笔记..."
                rows={3}
                className="w-full rounded-md border border-[var(--console-border-soft)] px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void saveNote()}
                className="mt-1 rounded-md border border-opus-light px-3 py-1 text-xs text-opus-dark hover:bg-opus-bg"
              >
                保存备注
              </button>
            </div>
          )}
        </section>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void onStatusChange(article.id, 'inbox')}
          className="rounded-md border border-[var(--console-border-soft)] px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
        >
          设为 Inbox
        </button>
        <button
          type="button"
          onClick={() => void onStatusChange(article.id, 'read')}
          className="rounded-md border border-[var(--console-border-soft)] px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
        >
          标记已读
        </button>
        <button
          type="button"
          onClick={() => void onStatusChange(article.id, 'starred')}
          className="rounded-md border border-conn-amber-ring px-3 py-1.5 text-xs text-conn-amber-text hover:bg-conn-amber-bg"
        >
          收藏
        </button>
        {onDelete &&
          (confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-conn-red-text">确认删除？</span>
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-conn-red-bg"
              >
                删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-[var(--console-border-soft)] px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md border border-conn-red-ring px-3 py-1.5 text-xs text-conn-red-text hover:bg-conn-red-bg"
            >
              删除
            </button>
          ))}
      </div>
    </aside>
  );
}
