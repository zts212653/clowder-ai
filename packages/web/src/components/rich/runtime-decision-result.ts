import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import type { DecisionResultStatus } from './ApprovalResultRow';
import { decisionResultCopy } from './decision-result.shell-copy';
import type { RuntimeInteractionCopy } from './RuntimeInteractionCopy';

type Receipt = NonNullable<NonNullable<RuntimeInteractionRecord['terminal']>['response']>;
type Question = Extract<RuntimeInteractionRecord['request'], { kind: 'question' }>;

function questionChoices(request: Question, response: Extract<Receipt, { kind: 'answers' }>): string[] {
  const labels: string[] = [];
  for (const question of request.questions) {
    if (question.isSecret) continue;
    const indexes = response.selectedOptionIndexes?.[question.id];
    if (!Array.isArray(indexes)) continue;
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0) continue;
      const option = question.options?.[index];
      if (option) labels.push(option.label);
    }
  }
  return [...new Set(labels)];
}

function selectedChoices(record: RuntimeInteractionRecord): string[] {
  const response = record.terminal?.response,
    request = record.request;
  if (response?.kind === 'answers' && request.kind === 'question') return questionChoices(request, response);
  if (response?.kind !== 'decision' || request.kind === 'question' || request.kind === 'conversation_decision')
    return [];
  const choice = request.decisions.find((decision) => decision.id === response.decisionId);
  return choice ? [choice.label] : [];
}

function closedLabel(record: RuntimeInteractionRecord, copy: RuntimeInteractionCopy): string {
  const labels = {
    user_cancelled: copy.terminal.cancelled,
    host_restarted: copy.terminal.restarted,
    transport_lost: copy.terminal.lost,
    confirmation_unavailable: copy.terminal.unavailable,
    surface_publication_failed: copy.terminal.publicationFailed,
  };
  const reason = record.terminal?.reasonCode;
  return reason && Object.hasOwn(labels, reason) ? labels[reason as keyof typeof labels] : copy.terminal.invalid;
}

/** Project only values retained in the canonical terminal. Private provider answers stay redacted. */
export function runtimeDecisionResult(
  record: RuntimeInteractionRecord,
  t: typeof decisionResultCopy.zh,
  copy: RuntimeInteractionCopy,
): { status: DecisionResultStatus; label: string } {
  const reason = record.terminal?.reasonCode;
  if (reason === 'expired') return { status: 'expired', label: `${t.expired} · ${record.request.title}` };
  if (reason === 'withdrawn') return { status: 'withdrawn', label: `${t.withdrawn} · ${record.request.title}` };
  const choices = selectedChoices(record);
  if (choices.length)
    return {
      status:
        record.status === 'declined' || reason === 'user_rejected'
          ? 'rejected'
          : record.status === 'answered'
            ? 'approved'
            : 'closed',
      label: t.selected(choices.join(' / ')),
    };
  if (record.status === 'declined' || reason === 'user_rejected')
    return { status: 'rejected', label: `${t.declined} · ${record.request.title}` };
  if (record.status !== 'answered') return { status: 'closed', label: closedLabel(record, copy) };
  const outcome = choices.length
    ? t.selected(choices.join(' / '))
    : record.request.kind === 'question'
      ? copy.terminal.answered
      : copy.terminal.handled;
  return { status: 'approved', label: `${t.approved} · ${outcome}` };
}
