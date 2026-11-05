'use client';

import type { MatterEntryView, MatterPage, MessageFrom } from '@cat-cafe/shared';
import Link from 'next/link';
import { useCatData } from '@/hooks/useCatData';
import { formatMemoryDate } from '../memory/page/use-memory-read';

/** The enclosing receipt has already fenced this exact page and its source revisions. */
export function MatterReadContent({ page }: { page: MatterPage }) {
  const { getCatById } = useCatData();
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
  return (
    <div className="space-y-4 [overflow-wrap:anywhere]">
      <section aria-label="猫的归纳" className="rounded-lg bg-cafe-surface-sunken p-3">
        <p className="mb-2 text-xs text-cafe-muted">猫的归纳（非原话） · 第 {page.matter.revision} 版</p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {page.matter.description?.trim() ? page.matter.description : '这次读取没有附语境说明。'}
        </p>
      </section>
      <section aria-label="原话与出处" className="divide-y divide-cafe-subtle">
        {page.entries.map((entry) => (
          <article key={entry.entryId} className="space-y-2 py-3 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-2 text-xs text-cafe-muted">
              <span>
                {authorLabel(entry)} · {formatMemoryDate(entry.source.timestamp)}
              </span>
              <Link
                className="shell-focusable shrink-0 hover:underline"
                href={`/thread/${encodeURIComponent(entry.source.threadId)}?message=${encodeURIComponent(entry.source.messageId)}`}
              >
                出处 ›
              </Link>
            </div>
            <blockquote className="whitespace-pre-wrap text-sm leading-relaxed">{entry.quote}</blockquote>
          </article>
        ))}
      </section>
    </div>
  );
}
