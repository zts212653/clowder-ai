'use client';
import type { CollectiveDocumentView } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { collectiveDocumentCopy } from './collective-document.shell-copy';

/** The original review ledger stays with the owner; this is its authorized read projection. */
export function CollectiveDocumentComments({ value }: { value: CollectiveDocumentView }) {
  const copy = useShellCopy(collectiveDocumentCopy);
  return (
    <details className="max-h-64 shrink-0 overflow-auto border-t border-cafe-subtle p-3 text-xs">
      <summary>
        {copy.annotations} · {value.view.annotationPage.total}
      </summary>
      {value.view.historyReadOnly && <p className="py-2 text-cafe-muted">{copy.historical}</p>}
      <ol>
        {value.view.review.annotations.map((annotation) => (
          <li key={annotation.id} className="border-b border-cafe-subtle py-2">
            {'kind' in annotation.anchor && annotation.anchor.kind === 'text_quote' && (
              <blockquote className="border-l-2 border-cafe pl-2 text-cafe-muted">{annotation.anchor.quote}</blockquote>
            )}
            <p className="whitespace-pre-wrap">{annotation.body}</p>
            {annotation.replies?.map((reply) => (
              <p key={reply.id} className="ml-3 whitespace-pre-wrap py-1">
                {reply.body}
              </p>
            ))}
          </li>
        ))}
      </ol>
      {value.view.annotationPage.nextOffset !== undefined && (
        <p className="py-2 text-cafe-muted">{copy.moreComments}</p>
      )}
    </details>
  );
}
