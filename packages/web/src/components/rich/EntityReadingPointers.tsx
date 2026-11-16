import { entityProvenanceSchema } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { domainApprovalCopy } from './domain-approval.shell-copy';

/** Show exactly what the owner is approving, without treating a stored location as an access grant. */
export function EntityReadingPointers({ value }: { value: unknown }) {
  const t = useShellCopy(domainApprovalCopy);
  const parsed = entityProvenanceSchema.array().safeParse(value);
  if (!parsed.success || !parsed.data.length) return null;
  return (
    <details open className="rounded-lg border border-[var(--shell-hairline)] px-3 py-2">
      <summary className="shell-focusable cursor-pointer font-medium">{t.readingPointers}</summary>
      <ol data-testid="entity-reading-pointers" className="mt-2 space-y-3 text-sm">
        {parsed.data.map((pointer, index) => (
          <li key={`${pointer.source}:${index}`} className="whitespace-pre-wrap break-words">
            {pointer.note ? (
              <p>{pointer.note}</p>
            ) : (
              <p className="text-[var(--shell-muted)]">{t.readingPurposeMissing}</p>
            )}
            <dl className="text-xs text-[var(--shell-muted)]">
              {Object.entries(pointer)
                .filter(([key]) => key !== 'note')
                .map(([key, location]) => (
                  <div key={key} className="flex flex-wrap gap-x-2">
                    <dt>{t.readingCoordinates[key as keyof typeof t.readingCoordinates] ?? key}:</dt>
                    <dd className="m-0 break-all">
                      {Array.isArray(location) ? location.join(', ') : String(location)}
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ol>
    </details>
  );
}
