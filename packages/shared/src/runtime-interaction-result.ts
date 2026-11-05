import type { RuntimeInteractionRecord } from './types/runtime-interaction.js';

/** Default continuation is a system closure, never a human approval. All consumers share this meaning. */
export function runtimeTerminalDisposition(record: RuntimeInteractionRecord) {
  const reason = record.terminal?.reasonCode;
  if (reason === 'expired') return 'expired';
  if (reason === 'withdrawn') return 'withdrawn';
  if (reason === 'defaulted' || reason === 'superseded') return 'closed_without_decision';
  if (record.status === 'declined') return 'rejected';
  return record.status === 'answered' ? 'approved' : 'closed_without_decision';
}

/** Only named public options retained by the canonical terminal; never free text, defaults or secret answers. */
export function runtimePublicSelectedLabels(record: RuntimeInteractionRecord): string[] {
  const request = record.request,
    response = record.terminal?.response;
  if (request.kind === 'conversation_decision' && response?.kind === 'selection')
    return request.presentation.options
      .filter((option) => response.selectedIds.includes(option.id))
      .map((option) => option.label);
  if (request.kind === 'question' && response?.kind === 'answers') {
    const labels: string[] = [];
    for (const question of request.questions) {
      if (question.isSecret || response.secretQuestionIds.includes(question.id)) continue;
      for (const index of response.selectedOptionIndexes?.[question.id] ?? []) {
        if (!Number.isInteger(index) || index < 0) continue;
        const option = question.options?.[index];
        if (option) labels.push(option.label);
      }
    }
    return [...new Set(labels)];
  }
  if (request.kind !== 'question' && request.kind !== 'conversation_decision' && response?.kind === 'decision') {
    const decision = request.decisions.find((option) => option.id === response.decisionId);
    return decision ? [decision.label] : [];
  }
  return [];
}
