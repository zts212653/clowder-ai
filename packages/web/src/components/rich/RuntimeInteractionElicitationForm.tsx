import type {
  RuntimeInteractionDecision,
  RuntimeInteractionObjectSchema,
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
} from '@cat-cafe/shared';
import { useId, useMemo, useState } from 'react';
import { CLASSIC_RUNTIME_INTERACTION_COPY, type RuntimeInteractionCopy } from './RuntimeInteractionCopy';
import { RuntimeInteractionDecisionActions } from './RuntimeInteractionDecisionActions';

type ElicitationRequest = Extract<RuntimeInteractionRequest, { kind: 'elicitation' }>;
type Primitive = string | number | boolean;

export function RuntimeInteractionElicitationForm({
  request,
  disabled,
  onSubmit,
  copy = CLASSIC_RUNTIME_INTERACTION_COPY.elicitation,
}: {
  copy?: RuntimeInteractionCopy['elicitation'];
  request: ElicitationRequest;
  disabled: boolean;
  onSubmit: (response: RuntimeInteractionResponse) => void;
}) {
  if (request.mode === 'url') {
    const target = safeHttpUrl(request.url);
    return (
      <div className="space-y-3">
        <RequestMessage message={request.message} />
        {target ? (
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            className="block min-h-10 rounded-xl border border-cafe px-3 py-2 text-sm text-[var(--semantic-info)] underline"
          >
            {copy.open(target.host)}
          </a>
        ) : (
          <p className="rounded-xl border border-[var(--semantic-critical)] px-3 py-2 text-sm text-[var(--semantic-critical)]">
            {copy.unavailable}
          </p>
        )}
        <RuntimeInteractionDecisionActions
          decisions={request.decisions}
          disabled={disabled}
          onSelect={(decision) => onSubmit({ kind: 'decision', decisionId: decision.id })}
        />
      </div>
    );
  }
  return <FormElicitation request={request} disabled={disabled} onSubmit={onSubmit} copy={copy} />;
}

function FormElicitation({
  request,
  disabled,
  onSubmit,
  copy,
}: {
  copy: RuntimeInteractionCopy['elicitation'];
  request: Extract<ElicitationRequest, { mode: 'form' }>;
  disabled: boolean;
  onSubmit: (response: RuntimeInteractionResponse) => void;
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, Primitive>>(() => defaultValues(request.requestedSchema));
  const complete = useMemo(
    () => (request.requestedSchema.required ?? []).every((id) => values[id] !== undefined && values[id] !== ''),
    [request.requestedSchema.required, values],
  );
  const choose = (decision: RuntimeInteractionDecision): void => {
    if (decision.outcome === 'accept' && !complete) return;
    const content = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
    onSubmit({
      kind: 'decision',
      decisionId: decision.id,
      ...(decision.outcome === 'accept' ? { content } : {}),
    });
  };
  return (
    <div className="space-y-3">
      <RequestMessage message={request.message} />
      {Object.entries(request.requestedSchema.properties).map(([id, property]) => {
        const inputId = `${formId}-${id}`;
        return (
          <div key={id} className="block space-y-1.5 text-sm">
            <label htmlFor={inputId} className="font-semibold">
              {property.title ?? id}
            </label>
            {property.description ? (
              <span className="block text-xs text-cafe-muted">{property.description}</span>
            ) : null}
            <PrimitiveInput
              copy={copy}
              inputId={inputId}
              name={id}
              property={property}
              value={values[id]}
              disabled={disabled}
              onChange={(value) => setValues((current) => ({ ...current, [id]: value }))}
            />
          </div>
        );
      })}
      <RuntimeInteractionDecisionActions
        decisions={request.decisions}
        disabled={disabled}
        disabledFor={(decision) => decision.outcome === 'accept' && !complete}
        onSelect={choose}
      />
    </div>
  );
}

function PrimitiveInput({
  copy,
  inputId,
  name,
  property,
  value,
  disabled,
  onChange,
}: {
  copy: RuntimeInteractionCopy['elicitation'];
  inputId: string;
  name: string;
  property: RuntimeInteractionObjectSchema['properties'][string];
  value: Primitive | undefined;
  disabled: boolean;
  onChange: (value: Primitive) => void;
}) {
  if (property.type === 'boolean') {
    return (
      <select
        id={inputId}
        name={name}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(coerceValue(property.type, event.target.value))}
        className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3"
      >
        <option value="">{copy.choose}</option>
        {(property.enum ?? [true, false]).map((option) => (
          <option key={String(option)} value={String(option)}>
            {option ? copy.yes : copy.no}
          </option>
        ))}
      </select>
    );
  }
  if (property.enum) {
    return (
      <select
        id={inputId}
        name={name}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(coerceValue(property.type, event.target.value))}
        className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3"
      >
        <option value="">{copy.choose}</option>
        {property.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={inputId}
      name={name}
      type={property.type === 'string' ? 'text' : 'number'}
      value={value === undefined ? '' : String(value)}
      disabled={disabled}
      min={property.minimum}
      max={property.maximum}
      minLength={property.minLength}
      maxLength={property.maxLength}
      step={property.type === 'integer' ? 1 : undefined}
      onChange={(event) => onChange(coerceValue(property.type, event.target.value))}
      className="min-h-10 w-full rounded-xl border border-cafe bg-cafe-surface px-3"
    />
  );
}

function defaultValues(schema: RuntimeInteractionObjectSchema): Record<string, Primitive> {
  return Object.fromEntries(
    Object.entries(schema.properties).flatMap(([id, property]) =>
      property.default === undefined ? [] : [[id, property.default]],
    ),
  );
}

function coerceValue(type: string, value: string): Primitive {
  if (value === '') return '';
  if (type === 'number' || type === 'integer') return Number(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

function RequestMessage({ message }: { message: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm text-cafe-muted">{message}</p>;
}

function safeHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}
