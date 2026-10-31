import type { CollectiveWorkProjection } from '@cat-cafe/shared';
import { useCollectiveLanguage } from './collective-copy.js';
import { formatWorkDate, workTimeLabels, workTimePresentation } from './project-time.js';

export function WorkTimeSummary({
  work,
  board = false,
}: {
  readonly work: CollectiveWorkProjection;
  readonly board?: boolean;
}) {
  const language = useCollectiveLanguage(),
    en = language === 'en';
  const value = workTimePresentation(work, language);
  if (!value || (board && value.field !== 'businessDeadline')) return null;
  const title = Object.entries(work.time ?? {})
    .map(
      ([field, fact]) =>
        `${workTimeLabels[field as keyof typeof workTimeLabels][en ? 1 : 0]} ${formatWorkDate(fact, language)} · ${fact.actor.displayName} · ${fact.timeZone}`,
    )
    .join('\n');
  const suggested = work.timeSuggestions?.some((item) => item.status === 'pending');
  return (
    <div className="work-time-summary" data-tone={value.tone} title={title}>
      <strong>
        {value.label}
        {value.tone !== 'overdue' && ` · ${value.date}`}
      </strong>
      {!board && (
        <small>
          {value.fact.actor.displayName}
          {value.field === 'estimatedCompletion' ? (en ? ' · estimate' : '估的') : en ? ' · confirmed' : '定'}
        </small>
      )}
      {!board && suggested && (
        <small className="work-time-pending">{en ? 'Date suggestion awaiting owner' : '新日期等负责人确认'}</small>
      )}
    </div>
  );
}
