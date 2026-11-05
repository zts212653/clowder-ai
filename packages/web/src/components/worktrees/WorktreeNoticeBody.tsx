'use client';

import { type WorktreeNotice, worktreeNoticeName, worktreeNoticePresentation } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { MarkdownContent } from '../MarkdownContent';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { worktreeNoticeCopy } from './worktree-notice.shell-copy';

/** A historical Host fact, not live worktree state and never an executable cleanup control. */
export function WorktreeNoticeBody({
  notice,
  getCatById,
}: {
  notice: WorktreeNotice;
  getCatById: (id: string) => CatData | undefined;
}) {
  const t = useShellCopy(worktreeNoticeCopy);
  const language = useShellLanguage();
  const copy = worktreeNoticePresentation(notice, t);
  const owner = getCatById(notice.owner);
  const date =
    notice.until && Number.isFinite(Date.parse(notice.until))
      ? new Date(notice.until).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
        })
      : undefined;
  const name = worktreeNoticeName(notice.path).replace(/[\\[\]`]/g, '\\$&');
  const link = `[${name}](<${encodeURI(notice.path).replaceAll('>', '%3E').replaceAll('<', '%3C')}>)`;
  const missing =
    notice.kind === 'merged-removed' ||
    notice.kind === 'merged-removal-interrupted' ||
    (notice.kind === 'merged-retirement-blocked' && Boolean(notice.archivePath));
  const details = [
    [t.path, notice.path],
    [t.source, notice.sourceRef],
    ...(notice.archivePath ? [[t.archive, notice.archivePath]] : []),
    ...(notice.restore ? [[t.restore, notice.restore]] : []),
    ...(notice.reason ? [[t.reason, notice.reason]] : []),
  ];
  return (
    <section className="min-w-0 text-sm" aria-label={copy.title}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="font-semibold">{copy.title}</strong>
        <span className="shrink-0 rounded-full border border-cafe-subtle px-2 py-0.5 text-micro font-medium text-cafe-secondary">
          {copy.status}
        </span>
      </div>
      <div className="mt-2 min-w-0 max-w-full">
        {missing ? (
          <p className="break-all font-medium">{worktreeNoticeName(notice.path)}</p>
        ) : (
          <MarkdownContent content={link} />
        )}
      </div>
      <p className="mt-2 text-sm leading-6 text-cafe-secondary">{copy.description}</p>
      <p className="mt-1 text-xs leading-5 text-cafe-secondary">
        {t.owner}：{owner ? formatCatDisplayName(owner) : notice.owner}
        {notice.ownerAction === 'queued' && <> · {t.ownerAction}</>}
        {notice.ownerAction === 'unavailable' && <> · {t.ownerUnavailable}</>}
        {date && (
          <>
            {' '}
            · {t.until}：{date}
          </>
        )}
      </p>
      <details className="mt-2 text-xs text-cafe-secondary">
        <summary className="w-fit cursor-pointer select-none rounded-sm py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {t.details}
        </summary>
        <dl className="mt-2 space-y-2">
          {details.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-medium">{label}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-all font-mono leading-5">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
