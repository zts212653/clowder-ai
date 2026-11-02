import type { ChangeCollectiveWorkTimeRequest, CollectiveTimeInput, CollectiveWorkProjection } from '@cat-cafe/shared';
import { useState } from 'react';
import { useCollectiveLanguage } from './collective-copy.js';
import { localDateTimeToInstant, timeFactToLocalDateTime, workTimeLabels } from './project-time.js';
import { RepeatedTimeChoice } from './RepeatedTimeChoice.js';

export type WorkTimeCommand = ChangeCollectiveWorkTimeRequest extends infer Command
  ? Command extends ChangeCollectiveWorkTimeRequest
    ? Omit<Command, 'serviceInstanceId' | 'collectiveId' | 'requestId' | 'workId' | 'expectedRevision'>
    : never
  : never;
export type WorkTimeChangeHandler = (work: CollectiveWorkProjection, command: WorkTimeCommand) => Promise<void>;

export function WorkTimeEditor({
  work,
  currentHumanId,
  suggest,
  onChange,
  onClose,
  sourceHint,
}: {
  readonly work: CollectiveWorkProjection;
  readonly currentHumanId: string;
  readonly suggest: boolean;
  readonly onChange: WorkTimeChangeHandler;
  readonly onClose: () => void;
  readonly sourceHint?: { text: string; eventId: string };
}) {
  const language = useCollectiveLanguage(),
    en = language === 'en';
  const owner = currentHumanId === work.accountableHumanId;
  const executor = work.assignment ? currentHumanId === work.assignment.humanId : owner;
  const fields = (['businessDeadline', 'reviewBy', 'plannedStart', 'estimatedCompletion'] as const).filter((field) =>
    suggest
      ? field === 'businessDeadline' || field === 'reviewBy'
      : field === 'estimatedCompletion'
        ? executor
        : field === 'plannedStart'
          ? owner || executor
          : owner,
  );
  const [field, setField] = useState(fields[0] ?? 'businessDeadline');
  const current = work.time?.[field];
  const [value, setValue] = useState(current ? timeFactToLocalDateTime(current) : '');
  const [selectedInstant, setSelectedInstant] = useState<string | undefined>(current?.value);
  const [timeZone, setTimeZone] = useState(current?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const submit = async (clear: boolean) => {
    setError('');
    setSaving(true);
    try {
      const time: CollectiveTimeInput | null = clear
        ? null
        : { value: localDateTimeToInstant(value, timeZone, selectedInstant), timeZone };
      if (suggest) {
        if (field !== 'businessDeadline' && field !== 'reviewBy') throw new Error('Invalid suggestion field');
        if (!reason.trim()) throw new Error(en ? 'Explain the suggested change' : '请写建议理由');
        await onChange(work, {
          action: 'suggest',
          field,
          time,
          reason: reason.trim(),
          ...(sourceHint ? { sourceEventId: sourceHint.eventId } : {}),
        });
      } else
        await onChange(work, {
          action: 'set',
          field,
          time,
          ...(sourceHint ? { sourceEventId: sourceHint.eventId } : {}),
        });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="work-time-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      {sourceHint && (
        <p>
          {en
            ? `The material mentions “${sourceHint.text}”. Choose the exact date, time and zone; this is still unconfirmed.`
            : `材料提到「${sourceHint.text}」。请明确日期、时刻和时区；现在还没有确认。`}
        </p>
      )}
      <label>
        {en ? 'Date kind' : '日期类型'}
        <select
          value={field}
          disabled={saving}
          onChange={(event) => {
            const next = fields.find((value) => value === event.target.value);
            if (!next) return;
            setField(next);
            const fact = work.time?.[next];
            setValue(fact ? timeFactToLocalDateTime(fact) : '');
            setSelectedInstant(fact?.value);
            if (fact) setTimeZone(fact.timeZone);
          }}
        >
          {fields.map((field) => (
            <option key={field} value={field}>
              {workTimeLabels[field][en ? 1 : 0]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {en ? 'Date and time' : '日期和时间'}
        <input
          type="datetime-local"
          value={value}
          required
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
      {suggest && (
        <>
          <label>
            {en ? 'Reason' : '理由'}
            <textarea
              value={reason}
              required
              maxLength={1000}
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p>
            {en
              ? 'A suggestion keeps the current date until the owner confirms.'
              : '建议不会改动当前日期，等负责人确认。'}
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="button" disabled={saving} onClick={onClose}>
          {en ? 'Cancel' : '取消'}
        </button>
        {!suggest && current && (
          <button type="button" disabled={saving} onClick={() => void submit(true)}>
            {en ? 'Clear date' : '清除日期'}
          </button>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving
            ? en
              ? 'Saving…'
              : '保存中…'
            : suggest
              ? en
                ? 'Suggest'
                : '提出建议'
              : en
                ? 'Save date'
                : '保存日期'}
        </button>
      </div>
    </form>
  );
}
