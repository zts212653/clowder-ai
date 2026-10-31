import { type FormEvent, useRef, useState } from 'react';

export interface VoteDraft {
  readonly question: string;
  readonly options: readonly string[];
  readonly closesAt: string;
}

export function VoteDraftForm({
  initialQuestion,
  title,
  explanation,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly initialQuestion: string;
  readonly title: string;
  readonly explanation: string;
  readonly submitLabel: string;
  readonly onSubmit: (draft: VoteDraft) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [question, setQuestion] = useState(initialQuestion.slice(0, 500));
  const [options, setOptions] = useState([
    { id: 0, value: '' },
    { id: 1, value: '' },
  ]);
  const nextOptionId = useRef(2);
  const [durationHours, setDurationHours] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const normalized = options.map((option) => option.value.trim());
  const valid =
    question.trim().length > 0 && normalized.every(Boolean) && new Set(normalized).size === normalized.length;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        question: question.trim(),
        options: normalized,
        closesAt: new Date(Date.now() + durationHours * 60 * 60 * 1_000).toISOString(),
      });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form
      className="vote-draft"
      aria-label={`${title}草稿`}
      onSubmit={(event) => void submit(event).catch(() => undefined)}
    >
      <header>
        <strong>{title}</strong>
        <span>{explanation}</span>
      </header>
      <label>
        <span>问题</span>
        <input
          aria-label="投票问题"
          value={question}
          maxLength={500}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      {options.map((option, index) => (
        <label key={option.id}>
          <span>选项 {index + 1}</span>
          <input
            aria-label={`投票选项 ${index + 1}`}
            value={option.value}
            maxLength={120}
            onChange={(event) =>
              setOptions((current) =>
                current.map((candidate) =>
                  candidate.id === option.id ? { ...candidate, value: event.target.value } : candidate,
                ),
              )
            }
          />
          {options.length > 2 && (
            <button
              type="button"
              className="quiet-action"
              onClick={() => setOptions((current) => current.filter((candidate) => candidate.id !== option.id))}
            >
              移除
            </button>
          )}
        </label>
      ))}
      <div className="vote-draft-controls">
        {options.length < 8 && (
          <button
            type="button"
            className="quiet-action"
            onClick={() => {
              const id = nextOptionId.current;
              nextOptionId.current += 1;
              setOptions((current) => [...current, { id, value: '' }]);
            }}
          >
            增加选项
          </button>
        )}
        <label>
          <span>收集多久</span>
          <select value={durationHours} onChange={(event) => setDurationHours(Number(event.target.value))}>
            <option value={24}>1 天</option>
            <option value={72}>3 天</option>
            <option value={168}>7 天</option>
          </select>
        </label>
        <button type="submit" disabled={!valid || submitting}>
          {submitting ? '正在发布…' : submitLabel}
        </button>
        <button type="button" className="quiet-action" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
