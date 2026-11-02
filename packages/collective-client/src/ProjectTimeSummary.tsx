import type { CollectiveRoadmapRecord, CollectiveTimeInput, CollectiveWorkProjection } from '@cat-cafe/shared';
import { useState } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';
import {
  formatWorkDate,
  localDateTimeToInstant,
  projectLatestDeadline,
  timeFactToLocalDateTime,
} from './project-time.js';
import { RepeatedTimeChoice } from './RepeatedTimeChoice.js';

export type ProjectTargetChangeHandler = (
  roadmap: CollectiveRoadmapRecord,
  time: CollectiveTimeInput | null,
) => Promise<void>;

export function ProjectTimeSummary({
  roadmap,
  works,
  currentHumanId,
  onChange,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly onChange?: ProjectTargetChangeHandler;
}) {
  const language = useCollectiveLanguage(),
    en = language === 'en';
  const [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [value, setValue] = useState(roadmap.targetDate ? timeFactToLocalDateTime(roadmap.targetDate) : '');
  const [selectedInstant, setSelectedInstant] = useState<string | undefined>(roadmap.targetDate?.value);
  const [timeZone, setTimeZone] = useState(
    roadmap.targetDate?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const latest = projectLatestDeadline(works),
    target = roadmap.targetDate;
  const save = async (clear: boolean) => {
    if (!onChange) return;
    setError('');
    setSaving(true);
    try {
      await onChange(
        roadmap,
        clear ? null : { value: localDateTimeToInstant(value, timeZone, selectedInstant), timeZone },
      );
      setEditing(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="project-time-target">
      <dt>{en ? 'Dates' : '时间'}</dt>
      <dd>
        {target ? (
          <>
            <strong>
              {en ? 'Target' : '目标'} · {formatWorkDate(target, language)}
            </strong>
            <small>
              {target.actor.displayName} · {target.timeZone}
            </small>
          </>
        ) : (
          <span>{en ? 'No project target' : '未设项目目标'}</span>
        )}
        {latest && (
          <small>
            {en ? 'Latest task deadline' : '任务里最晚的截止'} · {formatWorkDate(latest, language)}
          </small>
        )}
        {roadmap.accountableHumanId === currentHumanId && onChange && !editing && (
          <button
            type="button"
            onClick={() => {
              setValue(target ? timeFactToLocalDateTime(target) : '');
              setSelectedInstant(target?.value);
              setTimeZone(target?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
              setEditing(true);
            }}
          >
            {en ? 'Edit target…' : '改目标日期…'}
          </button>
        )}
        {editing && (
          <form
            className="work-time-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <label>
              {en ? 'Project target' : '项目目标'}
              <input
                type="datetime-local"
                required
                value={value}
                disabled={saving}
                onChange={(event) => {
                  setValue(event.target.value);
                  setSelectedInstant(undefined);
                }}
              />
            </label>
            <label>
              {en ? 'Time zone' : '时区'}
              <input
                value={timeZone}
                required
                disabled={saving}
                onChange={(event) => {
                  setTimeZone(event.target.value);
                  setSelectedInstant(undefined);
                }}
              />
            </label>
            <RepeatedTimeChoice
              value={value}
              timeZone={timeZone}
              selected={selectedInstant}
              onSelect={setSelectedInstant}
              disabled={saving}
              en={en}
            />
            <p>{en ? 'Task deadlines stay unchanged.' : '项目目标不改变任何任务的截止。'}</p>
            <div>
              <button type="button" disabled={saving} onClick={() => setEditing(false)}>
                {en ? 'Cancel' : '取消'}
              </button>
              {target && (
                <button type="button" disabled={saving} onClick={() => void save(true)}>
                  {en ? 'Clear target' : '清除目标'}
                </button>
              )}
              <button type="submit" className="primary" disabled={saving}>
                {en ? 'Save target' : '保存目标'}
              </button>
            </div>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
      </dd>
    </div>
  );
}
