'use client';
import { MarkdownContent } from '@/components/MarkdownContent';
import { CollectionGraph } from '../CollectionGraph';
import { MemoryReadState } from './MemoryReadState';
import { MemoryTasteDetail } from './MemoryTasteDetail';
import type { SearchDestination } from './memory-search-types';
import { isTasteBrowse, type TasteBrowse } from './taste-types';
import { useMemoryRead } from './use-memory-read';

export type SearchDetail =
  | Exclude<SearchDestination, { kind: 'message' }>
  | { kind: 'graph'; collection: string; anchor: string };
interface SearchDocument {
  title: string;
  content: string;
  truncated: boolean;
}
function isDocument(v: unknown): v is SearchDocument {
  if (!v || typeof v !== 'object') return false;
  const row = v as Record<string, unknown>;
  return typeof row.title === 'string' && typeof row.content === 'string' && typeof row.truncated === 'boolean';
}
function Document({ target, close }: { target: Extract<SearchDetail, { kind: 'document' }>; close: () => void }) {
  const params = new URLSearchParams({ collection: target.collection, anchor: target.anchor });
  const read = useMemoryRead<SearchDocument>(`/api/memory/search/document?${params}`, isDocument);
  return (
    <article className="min-w-0 space-y-4">
      <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
        返回搜索
      </button>
      <MemoryReadState {...read} empty={false} noun="文档原文" />
      {read.data && !read.error && !read.loading && (
        <>
          <h2 className="text-display-sm font-medium">{read.data.title || '文档 · 标题没有记录下来'}</h2>
          {read.data.truncated && <p className="text-compact text-cafe-muted">文档较长，这里只显示开头部分。</p>}
          <MarkdownContent content={read.data.content} />
        </>
      )}
    </article>
  );
}
export function MemorySearchDetail({
  target,
  close,
  reload,
}: {
  target: SearchDetail;
  close: () => void;
  reload: () => void;
}) {
  if (target.kind === 'taste') return <TasteSearchDetail target={target} close={close} reload={reload} />;
  if (target.kind === 'document') return <Document target={target} close={close} />;
  return (
    <section aria-label="搜索结果的关系图" className="space-y-4">
      <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
        返回搜索
      </button>
      <CollectionGraph initialAnchor={target.anchor} initialCollection={target.collection} presentation="titles" />
    </section>
  );
}

/** Search coordinates select only an actual, matching owner-readable list revision. */
function TasteSearchDetail({
  target,
  close,
  reload,
}: {
  target: Extract<SearchDetail, { kind: 'taste' }>;
  close: () => void;
  reload: () => void;
}) {
  const list = useMemoryRead<TasteBrowse>('/api/memory/taste', isTasteBrowse);
  const entry = list.data?.entries.find((item) => item.id === target.id && item.revision === target.revision);
  if (entry && !list.loading && !list.error)
    return <MemoryTasteDetail entry={entry} close={close} reload={reload} closeLabel="返回搜索" />;
  return (
    <section className="space-y-4">
      <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
        返回搜索
      </button>
      <MemoryReadState {...list} error={list.error || (!list.loading && !entry)} empty={false} noun="这条品味" />
      {!list.loading && !entry && (
        <p className="text-compact text-cafe-muted">
          版本可能已变化。
          <button type="button" onClick={reload} className="ml-2 text-cafe-accent underline">
            重新搜索
          </button>
        </p>
      )}
    </section>
  );
}
