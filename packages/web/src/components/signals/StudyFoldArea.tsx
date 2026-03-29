import type { StudyMeta } from '@cat-cafe/shared';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';
import { PodcastPlayer } from './PodcastPlayer';

interface StudyFoldAreaProps {
  readonly articleId: string;
  readonly studyMeta: StudyMeta | null;
  readonly onStartStudy: () => void;
  readonly onDiscuss?: () => void;
  readonly discussLoading?: boolean;
  readonly onLinkThread?: (threadId: string) => Promise<void>;
  readonly onUnlinkThread?: (threadId: string) => Promise<void>;
  readonly collections?: readonly { id: string; name: string }[] | undefined;
  readonly onAddToCollection?: (collectionId: string) => Promise<void>;
  readonly onCreateCollection?: (name: string) => Promise<void>;
  readonly onStudyMetaRefresh?: () => void;
}

function formatDate(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return iso;
  return new Date(d).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Returns the best thread to navigate to: first active linked thread > default */
function resolveDiscussThread(studyMeta: StudyMeta | null): string {
  const threads = studyMeta?.threads ?? [];
  const active = threads.find((t) => !t.stale);
  return active ? active.threadId : 'default';
}

async function fetchNoteContent(articleId: string, noteId: string): Promise<string> {
  const res = await apiFetch(
    `/api/signals/articles/${encodeURIComponent(articleId)}/notes/${encodeURIComponent(noteId)}`,
  );
  if (!res.ok) return '（无法加载笔记内容）';
  const data = (await res.json()) as { content?: string };
  return data.content ?? '（空）';
}

export function StudyFoldArea({
  articleId,
  studyMeta,
  onStartStudy,
  onDiscuss,
  discussLoading,
  onLinkThread,
  onUnlinkThread,
  collections,
  onAddToCollection,
  onCreateCollection,
  onStudyMetaRefresh,
}: StudyFoldAreaProps) {
  const [open, setOpen] = useState(!!studyMeta?.lastStudiedAt);
  const [linkInput, setLinkInput] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);
  const ime = useIMEGuard();

  const handleLinkThread = useCallback(async () => {
    const tid = linkInput.trim();
    if (!tid || !onLinkThread) return;
    await onLinkThread(tid);
    setLinkInput('');
  }, [linkInput, onLinkThread]);

  const threads = studyMeta?.threads ?? [];
  const artifacts = studyMeta?.artifacts ?? [];
  const notes = artifacts.filter((a) => a.kind === 'note');
  const podcasts = artifacts.filter((a) => a.kind === 'podcast');
  const reports = artifacts.filter((a) => a.kind === 'research-report');

  const hasContent = threads.length > 0 || artifacts.length > 0;
  const studyCount = threads.length + artifacts.length;

  // Use linked thread instead of hardcoded /thread/default
  const discussThread = resolveDiscussThread(studyMeta);
  const discussLink = `/thread/${encodeURIComponent(discussThread)}?signal=${encodeURIComponent(articleId)}`;

  // Note expansion state
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [loadingNote, setLoadingNote] = useState<string | null>(null);

  // Reset expanded note when article changes
  const prevArticleRef = useRef(articleId);
  useEffect(() => {
    if (articleId !== prevArticleRef.current) {
      prevArticleRef.current = articleId;
      setExpandedNote(null);
      setNoteContents({});
    }
  }, [articleId]);

  const toggleNote = useCallback(
    async (noteId: string) => {
      if (expandedNote === noteId) {
        setExpandedNote(null);
        return;
      }
      setExpandedNote(noteId);
      if (!noteContents[noteId]) {
        setLoadingNote(noteId);
        const content = await fetchNoteContent(articleId, noteId);
        setNoteContents((prev) => ({ ...prev, [noteId]: content }));
        setLoadingNote(null);
      }
    },
    [expandedNote, noteContents, articleId],
  );

  return (
    <section className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-t-lg border border-cafe bg-cafe-surface-elevated px-3 py-2 text-left text-xs font-semibold text-cafe-secondary"
      >
        <span>
          {open ? '▾' : '▸'} 学习区
          {studyCount > 0 && <span className="ml-1 text-opus-dark">({studyCount})</span>}
        </span>
        {studyMeta?.lastStudiedAt && (
          <span className="text-xs font-normal text-cafe-muted">上次学习: {formatDate(studyMeta.lastStudiedAt)}</span>
        )}
      </button>
      {open && (
        <div className="rounded-b-lg border border-t-0 border-cafe bg-cafe-surface-elevated p-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onStartStudy}
              className="rounded-md bg-opus-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-opus-dark"
            >
              开始学习
            </button>
            <button
              type="button"
              onClick={onDiscuss}
              disabled={discussLoading}
              className="rounded-md border border-cafe px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface-elevated disabled:opacity-50"
            >
              {discussLoading ? '正在创建讨论...' : '在对话中讨论'}
            </button>
            {/* AC-6: 多猫研究派发 — signal param binds article context via activeSignals */}
            <a
              href={`${discussLink}&research=multi`}
              className="rounded-md border border-emerald-300 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50"
            >
              多猫研究
            </a>
          </div>

          {threads.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-cafe-secondary">关联对话</h4>
              <ul className="mt-1 space-y-1">
                {threads.map((t) => (
                  <li key={t.threadId} className="flex items-center gap-1">
                    <a
                      href={`/thread/${encodeURIComponent(t.threadId)}`}
                      className="flex flex-1 items-center justify-between rounded-md border border-cafe bg-cafe-surface px-3 py-1.5 text-xs text-opus-dark hover:bg-opus-bg"
                    >
                      <span className="truncate">{t.threadId}</span>
                      <span className="ml-2 shrink-0 text-cafe-muted">{formatDate(t.linkedAt)}</span>
                    </a>
                    {onUnlinkThread && (
                      <button
                        type="button"
                        onClick={() => void onUnlinkThread(t.threadId)}
                        className="shrink-0 rounded border border-red-200 px-1.5 py-1 text-[10px] text-red-500 hover:bg-red-50"
                        title="取消关联"
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {onLinkThread && (
            <div className="mt-3 flex gap-2">
              <input
                ref={linkInputRef}
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => {
                  if (ime.isComposing()) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleLinkThread();
                  }
                }}
                placeholder="输入 Thread ID 关联..."
                className="flex-1 rounded-md border border-cafe px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => void handleLinkThread()}
                className="rounded-md border border-opus-light px-2 py-1 text-xs text-opus-dark hover:bg-opus-bg"
              >
                关联
              </button>
            </div>
          )}

          {notes.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-cafe-secondary">学习笔记</h4>
              <ul className="mt-1 space-y-1">
                {notes.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => void toggleNote(n.id)}
                      className="flex w-full items-center justify-between rounded-md border border-cafe bg-cafe-surface px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface-elevated"
                      data-testid={`note-toggle-${n.id}`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="text-cafe-muted">{expandedNote === n.id ? '▾' : '▸'}</span>
                        <span className="font-medium">{n.id}</span>
                      </span>
                      <span className="text-cafe-muted">
                        {n.state} · {formatDate(n.createdAt)}
                      </span>
                    </button>
                    {expandedNote === n.id && (
                      <div className="mt-1 rounded-md border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-xs text-cafe-secondary">
                        {loadingNote === n.id ? (
                          <span className="text-cafe-muted">加载中...</span>
                        ) : (
                          <pre className="whitespace-pre-wrap">{noteContents[n.id] ?? ''}</pre>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* AC-5: 播客播放器 */}
          <PodcastPlayer articleId={articleId} podcasts={podcasts} onArtifactCreated={onStudyMetaRefresh} />

          {reports.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-cafe-secondary">研究报告</h4>
              <ul className="mt-1 space-y-1">
                {reports.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-md border border-cafe bg-cafe-surface px-3 py-1.5 text-xs text-cafe-secondary"
                  >
                    <span className="font-medium">{r.id}</span>
                    <span className="ml-2 text-cafe-muted">
                      {r.state} · {formatDate(r.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* AC-18: 学习集 */}
          {(studyMeta?.collections?.length ?? 0) > 0 && collections && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-cafe-secondary">所属学习集</h4>
              <ul className="mt-1 flex flex-wrap gap-1">
                {studyMeta?.collections?.map((colId) => {
                  const col = collections.find((c) => c.id === colId);
                  return (
                    <li
                      key={colId}
                      className="rounded-full border border-opus-light bg-opus-bg px-2 py-0.5 text-xs text-opus-dark"
                    >
                      {col?.name ?? colId}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {onAddToCollection && collections && collections.length > 0 && (
            <div className="mt-2">
              <select
                onChange={(e) => {
                  if (e.target.value) void onAddToCollection(e.target.value);
                  e.target.value = '';
                }}
                className="rounded-md border border-cafe px-2 py-1 text-xs"
                defaultValue=""
              >
                <option value="" disabled>
                  加入学习集...
                </option>
                {collections
                  .filter((c) => !studyMeta?.collections?.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {onCreateCollection && (
            <div className="mt-2 flex gap-2">
              <input
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => {
                  if (ime.isComposing()) return;
                  if (e.key === 'Enter' && newCollectionName.trim()) {
                    e.preventDefault();
                    void onCreateCollection(newCollectionName.trim());
                    setNewCollectionName('');
                  }
                }}
                placeholder="新建学习集..."
                className="flex-1 rounded-md border border-cafe px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  if (newCollectionName.trim()) {
                    void onCreateCollection(newCollectionName.trim());
                    setNewCollectionName('');
                  }
                }}
                className="rounded-md border border-opus-light px-2 py-1 text-xs text-opus-dark hover:bg-opus-bg"
              >
                创建
              </button>
            </div>
          )}

          {!hasContent && !studyMeta?.collections?.length && (
            <p className="mt-3 text-xs text-cafe-muted">还没有学习记录，点击「开始学习」开始吧。</p>
          )}
        </div>
      )}
    </section>
  );
}
