'use client';

import type { MatterPage } from '@cat-cafe/shared';
import { MatterEntryContent, MatterSummaryAuthor } from '../memory/page/MatterEntryContent';

/** The enclosing receipt has already fenced this exact page and its source revisions. */
export function MatterReadContent({ page }: { page: MatterPage }) {
  return (
    <div className="space-y-4 [overflow-wrap:anywhere]">
      <section aria-label="猫的归纳" className="rounded-lg bg-cafe-surface-sunken p-3">
        <p className="mb-2 text-xs text-cafe-muted">
          <MatterSummaryAuthor author={page.matter.descriptionAuthor} /> · 第 {page.matter.revision} 版
        </p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {page.matter.description?.trim() ? page.matter.description : '这次读取没有附语境说明。'}
        </p>
      </section>
      <section aria-label="原话与出处" className="divide-y divide-cafe-subtle">
        {page.entries.map((entry) => (
          <article key={entry.entryId} className="space-y-2 py-3 first:pt-0">
            <MatterEntryContent entry={entry} />
          </article>
        ))}
      </section>
    </div>
  );
}
