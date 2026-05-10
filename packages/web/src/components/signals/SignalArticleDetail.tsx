import type { SignalArticleStatus, StudyMeta } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import type { SignalArticleDetail } from '@/utils/signals-api';
import { fetchStudyMeta, linkSignalThread, unlinkSignalThread } from '@/utils/signals-api';
import { getThreadHref } from '../ThreadSidebar/thread-navigation';
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
  const router = useRouter();
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
    setExpandContent(false);
    setEnrichedContent(null);
    setEnrichError(null);
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
      router.push(`${getThreadHref(data.threadId)}?${query.toString()}`);
    } finally {
      setDiscussLoading(false);
    }
  }, [article, discussLoading]);

  const REASON_LABEL: Record<string, string> = {
    already_enriched: '已获取过全文',
    no_better_content: '原始页面无可提取正文',
    fetch_403: '原始页面拒绝访问 (403)',
    fetch_404: '原始页面不存在 (404)',
  };

  const handleExpand = useCallback(async () => {
    if (expandContent) {
      setExpandContent(false);
      setEnrichError(null);
      return;
    }
    if (!article || enrichedContent || enriching) {
      setExpandContent(true);
      return;
    }
    setEnriching(true);
    setEnrichError(null);
    try {
      const res = await apiFetch(`/api/signals/articles/${encodeURIComponent(article.id)}/enrich`, { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { article?: { content?: string }; enriched?: boolean; reason?: string };
        if (data.article?.content && data.article.content.length > (article.content?.length ?? 0)) {
          setEnrichedContent(data.article.content);
        } else if (data.reason && data.reason !== 'already_enriched') {
          setEnrichError(REASON_LABEL[data.reason] ?? `获取失败: ${data.reason}`);
        }
      }
    } catch {
      setEnrichError('网络请求失败');
    }
    setEnriching(false);
    setExpandContent(true);
  }, [article, expandContent, enrichedContent, enriching]);

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
      <aside className="rounded-xl bg-[var(--console-panel-bg)] p-6 text-sm text-cafe-secondary">
        正在加载文章详情...
      </aside>
    );
  }

  if (!article) {
    return (
      <aside className="rounded-xl bg-[var(--console-panel-bg)] p-6 text-sm text-cafe-secondary">
        选择一篇文章查看详情。
      </aside>
    );
  }

  return (
    <aside className="rounded-xl bg-[var(--console-panel-bg)] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SignalTierBadge tier={article.tier} />
        <span className="rounded bg-cafe-surface-elevated px-2 py-0.5 text-xs font-medium text-cafe-secondary">
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
          className="console-button-ghost text-xs px-3 py-1.5"
        >
          打开原文 ↗
        </a>
        <button
          type="button"
          onClick={() => void navigateToDiscuss()}
          disabled={discussLoading}
          className="rounded-md bg-opus-bg px-3 py-1.5 text-xs text-opus-dark transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {discussLoading ? '正在跳转...' : studyMeta?.threads?.length ? '继续讨论' : '在对话中讨论'}
        </button>
      </div>
      {article.summary && (
        <section className="console-card mt-4 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-cafe-secondary">AI 摘要</h3>
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
          <button
            type="button"
            onClick={() => void handleExpand()}
            disabled={enriching}
            className="text-xs text-opus-dark hover:underline disabled:opacity-50"
          >
            {enriching ? '正在获取全文…' : expandContent ? '收起' : '展开阅读'}
          </button>
        </div>
        <div
          className={`mt-1 rounded-lg bg-[var(--console-card-soft-bg)] p-3 text-sm text-cafe-black ${expandContent ? '' : 'max-h-[300px] overflow-y-auto'}`}
        >
          <MarkdownContent content={enrichedContent || article.content || '（无正文）'} />
        </div>
        {enrichError && <p className="mt-2 text-xs text-conn-amber-text">{enrichError}</p>}
      </section>
      <section className="mt-4">
        <h3 className="text-xs font-semibold text-cafe-secondary">标签</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {article.tags.length === 0 ? (
            <span className="text-xs text-cafe-secondary">暂无标签</span>
          ) : (
            article.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-codex-bg px-2 py-0.5 text-xs text-codex-dark">
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
            className="flex-1 rounded-md bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe outline-none"
          />
          <button
            type="button"
            onClick={() => void addPendingTag()}
            className="rounded-md bg-codex-bg px-2.5 py-1.5 text-xs text-codex-dark transition-opacity hover:opacity-80"
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
                className="w-full rounded-md bg-[var(--console-field-bg)] px-3 py-2 text-sm text-cafe outline-none"
              />
              <button
                type="button"
                onClick={() => void saveNote()}
                className="mt-1 rounded-md bg-opus-bg px-3 py-1 text-xs text-opus-dark transition-opacity hover:opacity-80"
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
          className="rounded-md bg-[var(--console-card-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] transition hover:text-cafe"
        >
          设为 Inbox
        </button>
        <button
          type="button"
          onClick={() => void onStatusChange(article.id, 'read')}
          className="rounded-md bg-[var(--console-card-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] transition hover:text-cafe"
        >
          标记已读
        </button>
        <button
          type="button"
          onClick={() => void onStatusChange(article.id, 'starred')}
          className="rounded-md bg-conn-amber-bg px-3 py-1.5 text-xs font-medium text-conn-amber-text transition hover:opacity-80"
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
                className="rounded-md bg-conn-red-bg px-3 py-1.5 text-xs font-medium text-conn-red-text transition hover:opacity-80"
              >
                删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md bg-[var(--console-card-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] transition hover:text-cafe"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md bg-conn-red-bg px-3 py-1.5 text-xs font-medium text-conn-red-text transition hover:opacity-80"
            >
              删除
            </button>
          ))}
      </div>
    </aside>
  );
}
