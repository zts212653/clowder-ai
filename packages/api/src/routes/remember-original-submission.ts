import type { RememberGroupRow, RememberItem, RememberRowResult } from '@cat-cafe/shared';

const paths = {
  profile: 'propose-profile-update',
  taste: 'propose-taste',
  person: 'propose-person-memory',
  person_defer: 'defer-person-memory',
  person_abstain: 'record-proactive-memory-abstention',
  entity: 'propose-entity',
  event_correction: 'propose-event-memory-correction',
  matter: 'memory-matters/write',
} as const;
const revisions = { correct_claim: 'correct-claim', retire_claim: 'retire-claim', amend_event: 'amend-event' } as const;

export function originalRememberSubmission(item: RememberItem, groupId: string) {
  let path: string;
  const payload = { ...item.payload };
  if (item.target === 'person_revision') {
    const action = payload.action;
    if (typeof action !== 'string' || !Object.hasOwn(revisions, action)) return null;
    path = `person-memory/${revisions[action as keyof typeof revisions]}`;
    delete payload.action;
  } else path = paths[item.target];
  if (item.target !== 'person_abstain') {
    const key = item.target === 'matter' || item.target === 'person_revision' ? 'requestId' : 'clientRequestId';
    if (payload[key] === undefined) payload[key] = `${groupId}:${item.itemId}`;
  }
  return { path: `/api/callbacks/${path}`, payload };
}

export function rememberGroupRow(row: RememberRowResult, item?: RememberItem): RememberGroupRow {
  const result =
    row.result && typeof row.result === 'object' && !Array.isArray(row.result)
      ? (row.result as Record<string, unknown>)
      : {};
  const text = (key: string) => (typeof result[key] === 'string' ? result[key] : undefined);
  const status = text('status') ?? text('outcome');
  const proposalId = text('proposalId') ?? (row.target === 'person' ? text('candidateId') : undefined);
  const nestedId = (key: string, field: string) => {
    const value = result[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const id = (value as Record<string, unknown>)[field];
    return typeof id === 'string' ? id : undefined;
  };
  const resultRef =
    text('receiptId') ??
    text('matterId') ??
    nestedId('matter', 'matterId') ??
    nestedId('claim', 'claimId') ??
    nestedId('event', 'eventId');
  const personId =
    row.target === 'person_revision' && row.statusCode < 400 && (status === 'applied' || status === 'replayed')
      ? (nestedId('claim', 'personId') ??
        (item?.target === 'person_revision' && typeof item.payload.personId === 'string'
          ? item.payload.personId
          : undefined))
      : undefined;
  return {
    itemId: row.itemId,
    target: row.target,
    statusCode: row.statusCode,
    ...(proposalId ? { proposalId } : {}),
    ...(text('messageId') ? { messageId: text('messageId') } : {}),
    ...(resultRef ? { resultRef } : {}),
    ...(personId ? { personId } : {}),
    ...(status ? { status } : {}),
    ...(text('error') ? { error: text('error')?.slice(0, 500) } : {}),
  };
}
