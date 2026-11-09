'use client';
import type { MatterEntryView, MatterPage, MatterSourceInput, MessageFrom } from '@cat-cafe/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { MemoryMatterActions } from './MemoryMatterActions';
import { MemoryMatterSourceForm } from './MemoryMatterSourceForm';
import { MemoryReadState } from './MemoryReadState';
import { useMatterMutation } from './use-matter-mutation';
import { useMemoryPageTail } from './use-memory-page-tail';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

export function MemoryMatterDetail({ matterId, from }: { matterId: string; from?: string | null }) {
  const path = `/api/memory/matters/${encodeURIComponent(matterId)}?history=true&limit=30`;
  const read = useMemoryRead<MatterPage>(path);
  const {
    data: extra,
    loading: loadingMore,
    error: moreError,
    cursor,
    loadMore,
  } = useMemoryPageTail(path, read.data, (previous, page) => ({
    ...page,
    entries: [...(previous?.entries ?? []), ...page.entries],
  }));
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [removed, setRemoved] = useState(false);
  const { getCatById } = useCatData();
  const action = useMatterMutation((receipt) => {
    setEditing(false);
    setReplacement(null);
    if (receipt.outcome === 'forgotten') setRemoved(true);
    else read.retry();
  });
  useEffect(() => {
    setTitle(read.data?.matter.title ?? '');
    setDescription(read.data?.matter.description ?? '');
  }, [read.data]);
  const back = `/memory${from ? `?from=${encodeURIComponent(from)}` : ''}`;
  const matter = read.data?.matter;
  const entries = [...(read.data?.entries ?? []), ...(extra?.entries ?? [])];
  const speaker = (author: MessageFrom) =>
    author.kind === 'user'
      ? '你'
      : author.kind === 'agent'
        ? (getCatById(author.catId)?.displayName ?? '猫猫')
        : '外部来源';
  const authorLabel = (entry: MatterEntryView) =>
    entry.attribution === 'quoted_in_message'
      ? entry.verifiedQuotedAuthor
        ? `${speaker(entry.verifiedQuotedAuthor)} · 引自原消息`
        : `${speaker(entry.source.author)}的消息引用`
      : speaker(entry.source.author);
  const saveSource = (source: MatterSourceInput) => {
    if (!matter || !replacement) return;
    action.submit(
      replacement === 'append'
        ? { operation: 'append', matterId, expectedRevision: matter.revision, sources: [source] }
        : { operation: 'correct', matterId, expectedRevision: matter.revision, entryId: replacement, source },
    );
  };
  return (
    <section aria-label="事情详情" className="mx-auto max-w-4xl space-y-5">
      <Link href={back} className="shell-focusable text-sm text-cafe-muted hover:underline">
        ‹ 全部记忆
      </Link>
      {removed ? (
        <p role="status" className="text-sm text-cafe-muted">
          已忘记这件事
        </p>
      ) : (
        <>
          <MemoryReadState loading={read.loading} error={read.error} empty={false} noun="事情" retry={read.retry} />
          {action.error && (
            <p role="alert" className="text-sm text-cafe-muted">
              {action.error}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => (action.retryable ? void action.retry() : read.retry())}
              >
                {action.retryable ? '重试' : '重新读取'}
              </button>
            </p>
          )}
          {matter && (
            <>
              <header className="flex flex-wrap items-start justify-between gap-3">
                <h1 className="text-xl font-medium">{matter.title}</h1>
                <span className="text-xs text-cafe-muted">
                  {matter.status === 'retired' ? '已不再使用' : formatMemoryDate(matter.updatedAt)}
                </span>
              </header>
              {matter.description && (
                <div className="rounded-lg bg-cafe-surface-sunken p-4">
                  <p className="mb-2 text-xs text-cafe-muted">猫的说明</p>
                  {read.data?.summaryStatus === 'sources_changed' && (
                    <p role="status" className="mb-2 text-sm text-cafe-muted">
                      来源已更正，猫的归纳尚未复核。请核对原话后更新说明。
                    </p>
                  )}
                  <p className="whitespace-pre-wrap text-sm">{matter.description}</p>
                </div>
              )}
              <div className="flex gap-4 text-sm text-cafe-accent">
                <button
                  type="button"
                  className="shell-focusable hover:underline"
                  disabled={action.busy}
                  onClick={() => setEditing(!editing)}
                >
                  编辑说明
                </button>
                <button
                  type="button"
                  className="shell-focusable hover:underline"
                  disabled={action.busy}
                  onClick={() => setReplacement('append')}
                >
                  添加来源
                </button>
              </div>
              {editing && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    action.submit({
                      operation: 'edit',
                      matterId,
                      expectedRevision: matter.revision,
                      title,
                      description,
                    });
                  }}
                >
                  <label className="block text-sm">
                    标题
                    <input
                      required
                      maxLength={160}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
                    />
                  </label>
                  <label className="block text-sm">
                    说明
                    <textarea
                      maxLength={4000}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      className="mt-1 min-h-24 w-full rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-2"
                    />
                  </label>
                  <button
                    type="submit"
                    className="shell-focusable text-sm text-cafe-accent underline"
                    disabled={action.busy}
                  >
                    保存修改
                  </button>
                </form>
              )}
              {replacement && (
                <MemoryMatterSourceForm
                  key={replacement}
                  busy={action.busy}
                  submit={saveSource}
                  cancel={() => setReplacement(null)}
                />
              )}
              <div className="divide-y divide-cafe-subtle rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] px-4">
                {entries.map((entry) => (
                  <article key={entry.entryId} className="space-y-3 py-4">
                    <div className="flex flex-wrap justify-between gap-2 text-xs text-cafe-muted">
                      <span>
                        {authorLabel(entry)} · {formatMemoryDate(entry.source.timestamp)}
                      </span>
                      {entry.status !== 'active' && (
                        <span>{entry.status === 'superseded' ? '已替换' : '不再适用'}</span>
                      )}
                    </div>
                    {entry.sourceStatus === 'current' ? (
                      <blockquote className="whitespace-pre-wrap text-sm leading-relaxed">{entry.quote}</blockquote>
                    ) : (
                      <p className="text-sm text-cafe-muted">原消息已更正，请重新选择来源。</p>
                    )}
                    <div className="flex flex-wrap gap-4 text-sm">
                      <Link
                        href={`/thread/${encodeURIComponent(entry.source.threadId)}?message=${encodeURIComponent(entry.source.messageId)}`}
                        className="shell-focusable text-cafe-accent hover:underline"
                      >
                        出处 ›
                      </Link>
                      {entry.status === 'active' && (
                        <>
                          <button
                            type="button"
                            className="shell-focusable text-cafe-muted hover:underline"
                            disabled={action.busy}
                            onClick={() => setReplacement(entry.entryId)}
                          >
                            更换来源
                          </button>
                          <button
                            type="button"
                            className="shell-focusable text-cafe-muted hover:underline"
                            disabled={action.busy}
                            onClick={() =>
                              action.submit({
                                operation: 'retire_entry',
                                matterId,
                                expectedRevision: matter.revision,
                                entryId: entry.entryId,
                              })
                            }
                          >
                            标为不再适用
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {(cursor || moreError) && (
                <button
                  type="button"
                  className="shell-focusable text-sm text-cafe-accent underline"
                  disabled={loadingMore}
                  onClick={() => (moreError ? read.retry() : void loadMore())}
                >
                  {loadingMore ? '正在读取…' : moreError ? '页面已变化，重新读取' : '加载更多'}
                </button>
              )}
              <MemoryMatterActions
                matter={matter}
                onChanged={(receipt) => (receipt.outcome === 'forgotten' ? setRemoved(true) : read.retry())}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
