import type { InteractionEvent, PersonClaimVersion, PersonRelationship } from '@cat-cafe/shared';

export function claimText(claim: PersonClaimVersion): string {
  if (claim.payload.kind === 'user_assessment') return claim.payload.statement;
  if (claim.payload.kind === 'redacted') return '[redacted]';
  const rendered = typeof claim.payload.value === 'string' ? claim.payload.value : JSON.stringify(claim.payload.value);
  return `${claim.payload.predicate}: ${rendered}`;
}

export function relationshipText(relationship: PersonRelationship): string {
  if (relationship.status === 'current') return '当前关系';
  if (relationship.status === 'former') return '曾有关系';
  return '关系状态未确认';
}

export function eventText(event: InteractionEvent): string {
  return event.headline;
}
