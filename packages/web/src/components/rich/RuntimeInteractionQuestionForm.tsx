import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';

type QuestionRequest = Extract<RuntimeInteractionRequest, { kind: 'question' }>;
type Question = QuestionRequest['questions'][number];

export function RuntimeInteractionQuestionForm({
  request,
  disabled,
  onSubmit,
}: {
  request: QuestionRequest;
  disabled: boolean;
  onSubmit: (response: RuntimeInteractionResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const answers = useMemo(
    () =>
      Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          otherValues[question.id]?.trim() || values[question.id]?.trim() || '',
        ]),
      ),
    [otherValues, request.questions, values],
  );
  const complete = Object.values(answers).every((answer) => answer.length > 0);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || disabled) return;
        onSubmit({
          kind: 'answers',
          answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, [answer]])),
        });
      }}
    >
      {request.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          value={values[question.id] ?? ''}
          otherValue={otherValues[question.id] ?? ''}
          disabled={disabled}
          onValueChange={(value) => {
            setValues((current) => ({ ...current, [question.id]: value }));
            if (value) setOtherValues((current) => ({ ...current, [question.id]: '' }));
          }}
          onOtherValueChange={(value) => {
            setOtherValues((current) => ({ ...current, [question.id]: value }));
            if (value) setValues((current) => ({ ...current, [question.id]: '' }));
          }}
        />
      ))}
      <button
        type="submit"
        disabled={!complete || disabled}
        className="min-h-10 w-full rounded-xl bg-[var(--semantic-success)] px-3 py-2 text-sm font-medium text-[var(--cafe-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        提交回答
      </button>
    </form>
  );
}

function QuestionField({
  question,
  value,
  otherValue,
  disabled,
  onValueChange,
  onOtherValueChange,
}: {
  question: Question;
  value: string;
  otherValue: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onOtherValueChange: (value: string) => void;
}) {
  const inputId = `runtime-question-${question.id}`;
  const otherInputId = `${inputId}-other`;
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-sm font-semibold">{question.header}</legend>
      <p className="text-xs text-cafe-muted">{question.question}</p>
      <label htmlFor={inputId} className="sr-only">
        {question.question}
      </label>
      {question.options ? (
        <select
          id={inputId}
          name={question.id}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3 text-sm"
        >
          <option value="">请选择</option>
          {question.options.map((option) => (
            <option key={option.label} value={option.label}>
              {option.label}
              {option.description ? ` — ${option.description}` : ''}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          name={question.id}
          type={question.isSecret ? 'password' : 'text'}
          autoComplete={question.isSecret ? 'off' : undefined}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3 text-sm"
        />
      )}
      {question.isOther ? (
        <>
          <label htmlFor={otherInputId} className="sr-only">
            其他答案：{question.question}
          </label>
          <input
            id={otherInputId}
            name={`${question.id}-other`}
            type={question.isSecret ? 'password' : 'text'}
            placeholder="其他答案"
            value={otherValue}
            onChange={(event) => onOtherValueChange(event.target.value)}
            className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3 text-sm"
          />
        </>
      ) : null}
    </fieldset>
  );
}
