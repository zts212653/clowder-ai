import type { CatLifeSettingsInput } from '@cat-cafe/shared';
import styles from './CatHomePanel.module.css';

const WEEKDAYS = [
  ['mon', '一'],
  ['tue', '二'],
  ['wed', '三'],
  ['thu', '四'],
  ['fri', '五'],
  ['sat', '六'],
  ['sun', '日'],
] as const;

interface CatLifeSettingsFormProps {
  draft: CatLifeSettingsInput;
  onChange: (settings: CatLifeSettingsInput) => void;
}

export function CatLifeSettingsForm({ draft, onChange }: CatLifeSettingsFormProps) {
  const customDays = draft.rhythm.kind === 'custom' ? draft.rhythm.weekdays : [];
  const quietHours = draft.quietHours;
  return (
    <>
      <label className={styles.switchRow}>
        <span>
          <strong>私人时间</strong>
          <br />
          <span className={styles.hint}>暂停只收起闹钟，不会抹掉这份生活。</span>
        </span>
        <input
          name="enabled"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
      </label>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          生活节奏
          <select
            className={styles.select}
            value={draft.rhythm.kind}
            onChange={(event) => {
              const kind = event.target.value as CatLifeSettingsInput['rhythm']['kind'];
              onChange({
                ...draft,
                rhythm: kind === 'custom' ? { kind, weekdays: ['mon', 'wed', 'fri'] } : { kind },
              });
            }}
          >
            <option value="gentle">轻轻醒来 · 每周 3 次</option>
            <option value="daily">每天都留一点时间</option>
            <option value="weekends">只在周末</option>
            <option value="custom">自己挑日子</option>
          </select>
        </label>
        <label className={styles.field}>
          什么时候醒来
          <input
            className={styles.input}
            type="time"
            value={draft.wakeTime}
            onChange={(event) => onChange({ ...draft, wakeTime: event.target.value })}
          />
        </label>
        <label className={styles.wideField}>
          所在时区
          <input
            className={styles.input}
            value={draft.timezone}
            onChange={(event) => onChange({ ...draft, timezone: event.target.value })}
            placeholder="America/Los_Angeles"
          />
        </label>
        {draft.rhythm.kind === 'custom' && (
          <fieldset className={styles.wideField}>
            <legend>哪几天</legend>
            <div className={styles.weekdayRow}>
              {WEEKDAYS.map(([value, label]) => (
                <label className={styles.weekday} key={value}>
                  <input
                    type="checkbox"
                    checked={customDays.includes(value)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...customDays, value]
                        : customDays.filter((day) => day !== value);
                      if (next.length > 0) onChange({ ...draft, rhythm: { kind: 'custom', weekdays: next } });
                    }}
                  />
                  周{label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className={styles.wideField}>
          <span>
            <input
              type="checkbox"
              checked={Boolean(draft.quietHours)}
              onChange={(event) =>
                onChange({
                  ...draft,
                  ...(event.target.checked
                    ? { quietHours: { start: '23:00', end: '07:00' } }
                    : { quietHours: undefined }),
                })
              }
            />{' '}
            给它留一段不被唤醒的安静时间
          </span>
        </label>
        {quietHours && (
          <>
            <label className={styles.field}>
              安静开始
              <input
                className={styles.input}
                type="time"
                value={quietHours.start}
                onChange={(event) => onChange({ ...draft, quietHours: { ...quietHours, start: event.target.value } })}
              />
            </label>
            <label className={styles.field}>
              安静结束
              <input
                className={styles.input}
                type="time"
                value={quietHours.end}
                onChange={(event) => onChange({ ...draft, quietHours: { ...quietHours, end: event.target.value } })}
              />
            </label>
          </>
        )}
      </div>
    </>
  );
}
