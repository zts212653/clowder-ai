import type { VideoProjectScreening } from '@cat-cafe/shared';
import type { ProjectSnapshot } from '../api';
import { useScreeningCopy } from './screening.shell-copy';
import { earlierRegisteredScreenings } from './screening-comparison';

/** The selected film stays on the right; only earlier registered outputs can be the comparison. */
export function ScreeningVersionControls({
  project,
  screening,
  canCompare,
  compareId,
  onSelect,
  onCompare,
}: {
  project: ProjectSnapshot;
  screening: VideoProjectScreening | undefined;
  canCompare: boolean;
  compareId: string | null;
  onSelect: (screeningId: string) => void;
  onCompare: (screeningId: string | null) => void;
}) {
  const t = useScreeningCopy();
  const earlier = earlierRegisteredScreenings(project.document.screenings ?? [], screening?.id);
  return (
    <>
      <label className="text-xs text-cafe-secondary">
        {t.version}{' '}
        <select
          className="ml-1 max-w-32 rounded border border-cafe-subtle bg-[var(--shell-paper,var(--cafe-surface))] px-1 py-1 text-xs"
          value={screening?.id ?? ''}
          onChange={(event) => onSelect(event.target.value)}
        >
          {!screening && <option value="">{t.noFilm}</option>}
          {project.document.screenings?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} · {t.input(item.input.ownerRevision)}
            </option>
          ))}
        </select>
      </label>
      {canCompare && earlier.length > 0 && (
        <label className="text-xs text-cafe-secondary">
          {t.compare}{' '}
          <select
            aria-label={t.compareLabel}
            className="ml-1 max-w-28 rounded border border-cafe-subtle bg-[var(--shell-paper,var(--cafe-surface))] px-1 py-1 text-xs"
            value={compareId ?? ''}
            onChange={(event) => onCompare(event.target.value || null)}
          >
            <option value="">{t.current}</option>
            {earlier.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {t.input(item.input.ownerRevision)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
