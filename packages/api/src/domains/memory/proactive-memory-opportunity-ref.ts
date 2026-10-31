import { createHash } from 'node:crypto';
import { type ProactiveMemoryOpportunityRef, proactiveMemoryOpportunityRefSchema } from '@cat-cafe/shared';

const OPPORTUNITY_REF_DOMAIN = 'f282-opportunity-v1\0';

export function deriveProactiveMemoryOpportunityRef(invocationId: string): ProactiveMemoryOpportunityRef {
  const normalized = invocationId.trim();
  if (!normalized || normalized === 'unknown') {
    throw new Error('A verified invocation identity is required to derive an opportunity ref.');
  }
  const digest = createHash('sha256').update(OPPORTUNITY_REF_DOMAIN).update(normalized).digest('hex').slice(0, 32);
  return proactiveMemoryOpportunityRefSchema.parse(`opp_${digest}`);
}
