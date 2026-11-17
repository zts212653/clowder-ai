'use client';

import type { MatterEntryView, MatterSourceReference, MessageFrom } from '@cat-cafe/shared';
import Link from 'next/link';
import { useCatData } from '@/hooks/useCatData';
import { formatMemoryDate } from './use-memory-read';

export function matterSourceHref(source: MatterSourceReference): string {
  const path = `/thread/${encodeURIComponent(source.threadId)}`;
  return 'messageId' in source ? `${path}?message=${encodeURIComponent(source.messageId)}` : path;
}

export function MatterSummaryAuthor({ author }: { author?: MessageFrom }) {
  const { getCatById } = useCatData();
  const name =
    author?.kind === 'agent'
      ? (getCatById(author.catId)?.displayName ?? author.catId)
      : author?.kind === 'user'
        ? '你'
        : undefined;
  return <span>{name ? `${name}的归纳（非原话）` : '归纳作者未知（非原话）'}</span>;
}

/** One presentation for the Memory page, write card and response-source expansion. */
export function MatterEntryContent({ entry }: { entry: MatterEntryView }) {
  const { getCatById } = useCatData();
  const speaker = (author: MessageFrom) =>
    author.kind === 'user'
      ? '你'
      : author.kind === 'agent'
        ? (getCatById(author.catId)?.displayName ?? author.catId)
        : '系统或外部来源';
  const author = 'author' in entry.source ? entry.source.author : undefined;
  const timestamp = 'timestamp' in entry.source ? entry.source.timestamp : undefined;
  const sourceLabel =
    entry.attribution === 'quoted_in_message'
      ? entry.verifiedQuotedAuthor
        ? `${speaker(entry.verifiedQuotedAuthor)} · 引自原消息`
        : author
          ? `${speaker(author)}的消息引用`
          : '原引用作者未知'
      : author
        ? speaker(author)
        : '线程出处';
  return (
    <div className="space-y-2">
      {entry.summary && (
        <div className="space-y-1">
          <p className="text-xs text-cafe-muted">
            <MatterSummaryAuthor author={entry.summaryAuthor} />
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.summary}</p>
        </div>
      )}
      <p className="text-xs text-cafe-muted">
        {sourceLabel}
        {timestamp !== undefined ? ` · ${formatMemoryDate(timestamp)}` : ''}
        {entry.status !== 'active' ? ` · ${entry.status === 'superseded' ? '已替换' : '不再适用'}` : ''}
      </p>
      {entry.sourceStatus === 'changed' ? (
        <p className="text-sm text-cafe-muted">来源消息已更正，归纳尚未复核；请回原对话核对。</p>
      ) : (
        entry.quote && <blockquote className="whitespace-pre-wrap text-sm leading-relaxed">{entry.quote}</blockquote>
      )}
      {'kind' in entry.source && (
        <p className="text-xs text-cafe-muted">
          {entry.source.origin === 'invocation' ? '记录发生处，未核验逐字原话。' : '回源指针，未核验逐字原话。'}
          {entry.source.kind === 'thread' ? '仅定位到线程，可在原对话中查找。' : ''}
        </p>
      )}
      <Link
        href={matterSourceHref(entry.source)}
        className="shell-focusable inline-block text-sm text-cafe-accent hover:underline"
      >
        {'messageId' in entry.source ? '查看原消息' : '查看原对话'}
      </Link>
    </div>
  );
}
