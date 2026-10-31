import type { VideoProjectDocumentV1 } from '@cat-cafe/shared';
import type { ContentSettlementReceiptV1 } from '../content-owner/types.js';
import type { VideoProjectPrincipal } from './access.js';

export interface VideoProjectDecisionCommand {
  readonly principal: VideoProjectPrincipal;
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly operationId: string;
  readonly decisionId: string;
  readonly action: 'decide' | 'reopen' | 'withdraw';
  readonly optionId?: string;
  readonly answer?: string;
  readonly reason?: string;
}

export function applyVideoProjectDecision(
  input: VideoProjectDecisionCommand,
  base: VideoProjectDocumentV1,
  now: string,
) {
  if (!['decide', 'reopen', 'withdraw'].includes(input.action)) throw new Error('Unknown decision action');
  const document = structuredClone(base);
  const decision = document.decisions.find((candidate) => candidate.id === input.decisionId);
  if (!decision || decision.decider.kind !== 'human' || decision.decider.actorId !== input.principal.actor.actorId)
    throw new Error('Decision owner mismatch');
  if (input.action === 'decide') {
    if (decision.state !== 'open' || (input.optionId === undefined) === (input.answer === undefined))
      throw new Error('Decision must choose one current option or answer');
    if (input.optionId !== undefined && !decision.options?.some((option) => option.id === input.optionId))
      throw new Error('Decision option no longer exists');
  } else {
    if (input.optionId !== undefined || input.answer !== undefined) throw new Error('Only deciding accepts an answer');
    if (input.action === 'reopen' && !input.reason?.trim()) throw new Error('Reopening requires a reason');
  }
  decision.state = input.action === 'decide' ? 'decided' : input.action === 'reopen' ? 'open' : 'withdrawn';
  decision.history.push({
    kind: input.action === 'decide' ? 'decided' : input.action === 'reopen' ? 'reopened' : 'withdrawn',
    actor: { ...input.principal.actor },
    at: now,
    operationId: input.operationId,
    ...(input.optionId !== undefined ? { optionId: input.optionId } : {}),
    ...(input.answer !== undefined ? { answer: input.answer } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  return document;
}

export function replayVideoProjectDecision(
  input: VideoProjectDecisionCommand,
  receipt: ContentSettlementReceiptV1,
  document: VideoProjectDocumentV1,
) {
  const decision = document.decisions.find((candidate) => candidate.id === input.decisionId);
  const event = decision?.history.find((candidate) => candidate.operationId === input.operationId);
  return (
    receipt.previousOwnerRevision === input.expectedOwnerRevision &&
    receipt.actor.kind === input.principal.actor.kind &&
    receipt.actor.actorId === input.principal.actor.actorId &&
    event?.kind === (input.action === 'decide' ? 'decided' : input.action === 'reopen' ? 'reopened' : 'withdrawn') &&
    event.optionId === input.optionId &&
    event.answer === input.answer &&
    event.reason === input.reason
  );
}
