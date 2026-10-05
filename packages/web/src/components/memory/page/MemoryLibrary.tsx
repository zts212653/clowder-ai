'use client';
import { useState } from 'react';
import type { IndexStatusData } from '../IndexStatus';
import { MemoryReadState } from './MemoryReadState';
import { type MaintenanceData, MemoryStatusCard } from './MemoryStatus';
import { formatMemoryDate, type MemoryRead, useMemoryRead } from './use-memory-read';

export interface LibraryCollection {
  id: string;
  name: string;
  kind: string;
  visibility: string;
  status: string;
  readStatus: 'ready' | 'unavailable';
  docCount: number | null;
  lastDocumentUpdatedAt: string | null;
}
export interface LibraryCandidate {
  id: string;
  content: string;
  kind: string;
  createdAt: string;
  collectionName: string | null;
  state: string;
}
const KINDS: Record<string, string> = {
  project: '项目',
  global: '全局',
  world: '世界',
  domain: '领域',
  research: '调研',
  lesson: '教训',
  decision: '决策',
  method: '方法',
};
const VISIBILITY: Record<string, string> = { public: '公开', internal: '内部', private: '私有', restricted: '受限' };
const STATUSES: Record<string, string> = {
  registered: '待索引',
  indexing: '索引中',
  stale: '待更新',
  blocked: '暂不可用',
  archived: '已归档',
};

export function MemoryLibrary({
  index,
  maintenance,
}: {
  index: MemoryRead<IndexStatusData>;
  maintenance: MemoryRead<MaintenanceData>;
}) {
  const catalog = useMemoryRead<{ collections: LibraryCollection[] }>('/api/memory/catalog');
  const feed = useMemoryRead<{ pending: LibraryCandidate[]; processed: LibraryCandidate[] }>(
    '/api/memory/library-feed',
  );
  const [processed, setProcessed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const candidates = feed.data ? (processed ? feed.data.processed : feed.data.pending) : [];
  const partial =
    ([catalog, feed, index, maintenance].some((r) => r.error) || (index.data !== null && !index.data.healthy)) &&
    [catalog, feed, index, maintenance].some((r) => r.data !== null);
  return (
    <section aria-label="资料库" className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-display-sm font-medium">资料库</h1>
          <p className="mt-2 text-sm text-cafe-muted">猫能检索到的资料：项目文档、对话、教训，以及你接入的外部资料。</p>
        </div>
        <div className="text-right">
          <button
            type="button"
            disabled
            className="rounded-lg border border-cafe-subtle px-3 py-2 text-compact opacity-50"
          >
            ＋ 新建资料库
          </button>
          <p className="mt-1 text-xs text-cafe-muted">尚未接入</p>
        </div>
      </header>
      {partial && (
        <output className="block text-sm text-cafe-muted">
          部分读到：下面保留已读取的内容；未读到的部分各自注明。
        </output>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          <section aria-label="待收录">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-base font-medium">
                待收录 {feed.data && <span className="ml-1 text-cafe-muted">{feed.data.pending.length}</span>}
              </h2>
              <button
                type="button"
                onClick={() => setProcessed(!processed)}
                className="text-compact text-cafe-accent underline"
              >
                {processed ? '查看待收录' : '查看已处理'}
              </button>
            </div>
            <p className="mb-3 text-compact text-cafe-muted">猫提议写进资料库的内容，等你决定。</p>
            <MemoryReadState {...feed} empty={candidates.length === 0} noun={processed ? '已处理记录' : '待收录内容'} />
            <div className="space-y-3">
              {(showAll ? candidates : candidates.slice(0, 2)).map((item) => (
                <article key={item.id} className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-compact text-cafe-muted">
                    <span>
                      {KINDS[item.kind] ?? '资料'} · {formatMemoryDate(item.createdAt)}
                    </span>
                    <span>{item.state}</span>
                  </div>
                  <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-[1.55]">
                    {item.content}
                  </p>
                  <details className="mt-2 text-compact text-cafe-secondary">
                    <summary className="cursor-pointer text-cafe-accent">展开提议</summary>
                    <p className="mt-2 whitespace-pre-wrap break-words">{item.content}</p>
                  </details>
                  <p className="mt-3 text-compact text-cafe-muted">
                    {item.collectionName ? `来源资料库：${item.collectionName}` : '来源资料库没有记录下来'}
                  </p>
                  {!processed && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled
                        className="rounded-lg border border-cafe-subtle px-3 py-1.5 text-compact opacity-50"
                      >
                        收录
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded-lg border border-cafe-subtle px-3 py-1.5 text-compact opacity-50"
                      >
                        不收录
                      </button>
                      <span className="text-xs text-cafe-muted">尚未接入</span>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {candidates.length > 2 && (
              <button
                type="button"
                onClick={() => setShowAll(!showAll)}
                className="mt-3 text-compact text-cafe-accent underline"
              >
                {showAll ? '收起较早记录' : `还有 ${candidates.length - 2} 条 · 查看全部`}
              </button>
            )}
          </section>
          <section aria-label="全部资料库">
            <h2 className="mb-3 text-base font-medium">
              全部资料库{' '}
              {catalog.data && <span className="ml-2 text-cafe-muted">{catalog.data.collections.length} 个</span>}
            </h2>
            <MemoryReadState {...catalog} empty={!catalog.data?.collections.length} noun="资料库" />
            {catalog.data && (
              <div className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] px-4">
                <div className="hidden grid-cols-5 gap-3 border-b border-cafe-subtle py-3 text-compact text-cafe-muted md:grid">
                  <span className="col-span-2">名称</span>
                  <span>类型 / 可见范围</span>
                  <span>文档</span>
                  <span>文档最近更新</span>
                </div>
                {catalog.data.collections.map((item) => (
                  <div
                    key={item.id}
                    className="grid gap-2 border-b border-cafe-subtle py-4 last:border-0 md:grid-cols-5 md:gap-3"
                  >
                    <div className="min-w-0 md:col-span-2">
                      <p className="break-words text-sm font-medium">{item.name || '资料库 · 标题没有记录下来'}</p>
                      {item.status !== 'active' && (
                        <p className="mt-1 text-xs text-cafe-muted">{STATUSES[item.status] ?? '状态暂不可用'}</p>
                      )}
                    </div>
                    <p className="text-compact text-cafe-secondary">
                      {KINDS[item.kind] ?? '资料'} · {VISIBILITY[item.visibility] ?? '范围没有记录下来'}
                    </p>
                    <p className="text-compact text-cafe-secondary">
                      {item.docCount === null ? '文档数暂不可用' : `${item.docCount.toLocaleString()} 篇`}
                    </p>
                    <p className="text-compact text-cafe-muted">
                      {item.readStatus === 'unavailable'
                        ? '文档更新时间暂不可用'
                        : formatMemoryDate(item.lastDocumentUpdatedAt)}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-cafe-muted">只显示当前有权限读取的资料库。</p>
          </section>
        </div>
        <MemoryStatusCard index={index} maintenance={maintenance} />
      </div>
    </section>
  );
}
