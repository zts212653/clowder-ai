import { localDateTimeInstants } from './project-time.js';

export function RepeatedTimeChoice({
  value,
  timeZone,
  selected,
  onSelect,
  disabled,
  en,
}: {
  value: string;
  timeZone: string;
  selected?: string;
  onSelect(value: string): void;
  disabled: boolean;
  en: boolean;
}) {
  let choices: string[];
  try {
    choices = localDateTimeInstants(value, timeZone);
  } catch {
    return null;
  }
  if (choices.length < 2) return null;
  const normalized = selected && Number.isFinite(Date.parse(selected)) ? new Date(selected).toISOString() : '';
  return (
    <label>
      {en ? 'This time occurs twice' : '这个时间出现两次'}
      <select
        aria-label={en ? 'This time occurs twice' : '这个时间出现两次'}
        required
        disabled={disabled}
        value={choices.includes(normalized || '') ? normalized : ''}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">{en ? 'Choose an occurrence' : '请选择哪一次'}</option>
        {choices.map((instant, index) => (
          <option key={instant} value={instant}>
            {en ? `Occurrence ${index + 1}` : `第 ${index + 1} 次`} ·{' '}
            {new Intl.DateTimeFormat(en ? 'en-US' : 'zh-CN', {
              timeZone,
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'shortOffset',
              hourCycle: 'h23',
            }).format(Date.parse(instant))}
          </option>
        ))}
      </select>
    </label>
  );
}
