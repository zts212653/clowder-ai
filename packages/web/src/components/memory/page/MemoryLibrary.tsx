'use client';
import { useState } from 'react';
import { CreateCollectionDialog } from '../CreateCollectionDialog';
import type { IndexStatusData } from '../IndexStatus';
import { LIBRARY_KINDS as KINDS, LIBRARY_VISIBILITY as VISIBILITY } from './library-labels';
import { MemoryLibraryCandidate } from './MemoryLibraryCandidate';
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
  sourceCollectionId?: string | null;
  sourceVisibility?: string | null;
}
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
  const catalog = useMemoryRead<{ collections: LibraryCollection[]; defaultTargetCollectionId?: string | null }>(
    '/api/memory/catalog',
  );
  const feed = useMemoryRead<{ pending: LibraryCandidate[]; processed: LibraryCandidate[] }>(
    '/api/memory/library-feed',
  );
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
            onClick={() => setCreating(true)}
            className="rounded-lg border border-cafe-subtle px-3 py-2 text-compact"
          >
            ＋ 新建资料库
          </button>
        </div>
      </header>
      {notice && <output className="text-sm text-cafe-secondary">{notice}</output>}
      {creating && (
        <CreateCollectionDialog
          onClose={() => {
            setCreating(false);
            catalog.retry();
            index.retry();
          }}
          onCreated={() => {
            setCreating(false);
            setNotice('资料库已建好。');
            catalog.retry();
            index.retry();
          }}
        />
      )}
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
                {processed ? '已处理' : '待收录'}{' '}
                {feed.data && <span className="ml-1 text-cafe-muted">{candidates.length}</span>}
              </h2>
              <button
                type="button"
                onClick={() => setProcessed(!processed)}
                className="text-compact text-cafe-accent underline"
              >
                {processed ? '查看待收录' : '查看已处理'}
              </button>
            </div>
            <p className="mb-3 text-compact text-cafe-muted">
              {processed ? '已经处理过的提议，收录结果逐条注明。' : '猫提议写进资料库的内容，等你决定。'}
            </p>
            <MemoryReadState {...feed} empty={candidates.length === 0} noun={processed ? '已处理记录' : '待收录内容'} />
            <div className="space-y-3">
              {(showAll ? candidates : candidates.slice(0, 2)).map((item) => (
                <MemoryLibraryCandidate
                  key={item.id}
                  item={item}
                  collections={catalog.data?.collections ?? []}
                  defaultTargetCollectionId={catalog.data?.defaultTargetCollectionId ?? null}
                  processed={processed}
                  onChanged={(message) => {
                    setNotice(message);
                    feed.retry();
                    catalog.retry();
                    index.retry();
                  }}
                />
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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-medium">
                全部资料库{' '}
                {catalog.data && <span className="ml-2 text-cafe-muted">{catalog.data.collections.length} 个</span>}
              </h2>
              <a href="/memory/catalog?shell=v2" className="text-compact text-cafe-accent underline">
                管理资料库 ↗
              </a>
            </div>
            <p className="mb-3 text-compact text-cafe-muted">重建、归档和取消归档在原资料库管理页。</p>
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
