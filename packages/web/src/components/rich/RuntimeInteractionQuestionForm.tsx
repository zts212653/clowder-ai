import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { CLASSIC_RUNTIME_INTERACTION_COPY, type RuntimeInteractionCopy } from './RuntimeInteractionCopy';

type QuestionRequest = Extract<RuntimeInteractionRequest, { kind: 'question' }>;
type Question = QuestionRequest['questions'][number];

export function RuntimeInteractionQuestionForm({
  request,
  disabled,
  onSubmit,
  onReject,
  copy = CLASSIC_RUNTIME_INTERACTION_COPY.form,
  presentation,
  secondaryActions,
}: {
  request: QuestionRequest;
  copy?: RuntimeInteractionCopy['form'];
  presentation?: 'mailbox';
  secondaryActions?: ReactNode;
  disabled: boolean;
  onSubmit: (response: RuntimeInteractionResponse) => void;
  onReject: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [multiValues, setMultiValues] = useState<Record<string, string[]>>({});
  const [otherValues, setOtherValues] = useState<Record<string, string>>({});
  const answers = useMemo(
    () =>
      Object.fromEntries(
        request.questions.map((question) => {
          const typed = values[question.id]?.trim() ?? '';
          // The secondary "other" input only exists for option questions; a
          // question without options answers through the main text input.
          const other = question.options?.length ? (otherValues[question.id]?.trim() ?? '') : '';
          if (question.multiSelect) {
            // F306 Phase C (iCode parity): multi-select questions submit every
            // selected option; free text appends as an additional value. With
            // no options the main input IS the free-text path.
            const selected = question.options?.length ? (multiValues[question.id] ?? []) : [];
            const freeText = question.options?.length ? other : typed;
            return [question.id, freeText ? [...selected, freeText] : selected] as const;
          }
          const single = other || typed;
          return [question.id, single ? [single] : []] as const;
        }),
      ),
    [multiValues, otherValues, request.questions, values],
  );
  // iCode parity: a question marked allowUnanswered may stay empty; everything
  // else keeps the original "all questions answered" gate.
  const complete = request.questions.every(
    (question) => (answers[question.id]?.length ?? 0) > 0 || question.allowUnanswered === true,
  );

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || disabled) return;
        onSubmit({ kind: 'answers', answers });
      }}
    >
      {request.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          copy={copy}
          value={values[question.id] ?? ''}
          multiValue={multiValues[question.id] ?? []}
          otherValue={otherValues[question.id] ?? ''}
          disabled={disabled}
          onValueChange={(value) => {
            setValues((current) => ({ ...current, [question.id]: value }));
            if (value) setOtherValues((current) => ({ ...current, [question.id]: '' }));
          }}
          onToggleMulti={(label) => {
            setMultiValues((current) => {
              const selected = current[question.id] ?? [];
              return {
                ...current,
                [question.id]: selected.includes(label)
                  ? selected.filter((entry) => entry !== label)
                  : [...selected, label],
              };
            });
          }}
          onOtherValueChange={(value) => {
            setOtherValues((current) => ({ ...current, [question.id]: value }));
            // Single-choice semantics stay mutually exclusive; multi-select
            // free text appends instead of clearing the checkboxes.
            if (value && !question.multiSelect) setValues((current) => ({ ...current, [question.id]: '' }));
          }}
        />
      ))}
      <div
        className={
          presentation === 'mailbox' ? 'flex flex-wrap items-center gap-2' : 'grid grid-cols-1 gap-2 sm:grid-cols-2'
        }
      >
        <button
          type="button"
          disabled={disabled}
          onClick={onReject}
          className="min-h-10 rounded-xl border border-cafe px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.skip}
        </button>
        <button
          type="submit"
          disabled={!complete || disabled}
          className="min-h-10 rounded-xl bg-[var(--semantic-success)] px-3 py-2 text-sm font-medium text-[var(--cafe-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          style={
            presentation === 'mailbox'
              ? { background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }
              : undefined
          }
        >
          {copy.submit}
        </button>
        {secondaryActions}
      </div>
    </form>
  );
}

function QuestionField({
  question,
  copy,
  value,
  multiValue,
  otherValue,
  disabled,
  onValueChange,
  onToggleMulti,
  onOtherValueChange,
}: {
  question: Question;
  copy: RuntimeInteractionCopy['form'];
  value: string;
  multiValue: readonly string[];
  otherValue: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onToggleMulti: (label: string) => void;
  onOtherValueChange: (value: string) => void;
}) {
  const instanceId = useId();
  const inputId = `runtime-question-${question.id}-${instanceId}`;
  const otherInputId = `${inputId}-other`;
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-sm font-semibold">{question.header}</legend>
      <p className="text-xs text-cafe-muted">{question.question}</p>
      <label htmlFor={inputId} className="sr-only">
        {question.question}
      </label>
      {question.options ? (
        question.multiSelect ? (
          <div className="space-y-1.5">
            {question.options.map((option, index) => {
              const optionId = `${inputId}-option-${index}`;
              return (
                <label key={option.label} htmlFor={optionId} className="flex items-start gap-2 text-sm">
                  <input
                    id={optionId}
                    type="checkbox"
                    checked={multiValue.includes(option.label)}
                    onChange={() => onToggleMulti(option.label)}
                    className="mt-1"
                  />
                  <span>
                    {option.label}
                    {option.description ? <span className="text-cafe-muted"> — {option.description}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <select
            id={inputId}
            name={question.id}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3 text-sm"
          >
            <option value="">{copy.choose}</option>
            {question.options.map((option) => (
              <option key={option.label} value={option.label}>
                {option.label}
                {option.description ? ` — ${option.description}` : ''}
              </option>
            ))}
          </select>
        )
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
      {question.isOther && question.options ? (
        <>
          <label htmlFor={otherInputId} className="sr-only">
            {copy.otherLabel(question.question)}
          </label>
          <input
            id={otherInputId}
            name={`${question.id}-other`}
            type={question.isSecret ? 'password' : 'text'}
            placeholder={copy.other}
            value={otherValue}
            onChange={(event) => onOtherValueChange(event.target.value)}
            className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3 text-sm"
          />
        </>
      ) : null}
    </fieldset>
  );
}
