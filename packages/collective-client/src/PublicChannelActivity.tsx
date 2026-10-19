import type { CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { useCollectiveText } from './collective-copy.js';
import { participantLabel } from './participant-label.js';

/** Published Work progress is readable; it grants no private execution or stop authority. */
export function PublicChannelActivity({
  works,
  humanId,
  participants,
  hostAvailable,
  requestedEventIds,
  onOpen,
}: {
  readonly works: readonly CollectiveWorkProjection[];
  readonly humanId: string;
  readonly participants: readonly CollectiveParticipant[];
  readonly hostAvailable: boolean;
  readonly requestedEventIds: ReadonlySet<string>;
  readonly onOpen: (eventId: string) => void;
}) {
  const t = useCollectiveText();
  const active = works.filter(
    (work) =>
      work.status === 'in_progress' &&
      work.assignment &&
      (work.accountableHumanId === humanId || requestedEventIds.has(work.sourceEventId)) &&
      (!hostAvailable || work.assignment.humanId !== humanId),
  );
  if (!active.length) return null;
  const rows = active.map((work) => {
    const assignment = work.assignment;
    if (!assignment) return null;
    const cat = participants.find(
      (p) =>
        p.serviceInstanceId === work.serviceInstanceId &&
        p.collectiveId === work.collectiveId &&
        p.connectionId === assignment.connectionId &&
        p.humanId === assignment.humanId &&
        p.catId === assignment.catId,
    );
    return (
      <button key={work.workId} type="button" onClick={() => onOpen(work.sourceEventId)}>
        {cat ? participantLabel(cat, participants) : assignment.displayName} · {work.title} · {t('公开进度：推进中')}
      </button>
    );
  });
  return (
    <section className="public-channel-activity" aria-label={t('为我执行的公开任务')}>
      {rows.length === 1 ? (
        rows
      ) : (
        <details>
          <summary>
            {active.length} · {t('公开任务进行中')}
          </summary>
          <div>{rows}</div>
        </details>
      )}
    </section>
  );
}
