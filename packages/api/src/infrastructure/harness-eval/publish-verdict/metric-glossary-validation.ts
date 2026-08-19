import { metricRefKeyCandidates } from '@cat-cafe/shared';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';
import type { HandlerError } from './types.js';

/**
 * Reject metric refs that cannot be explained by the selected domain's
 * glossary before the publisher creates an evidence branch or PR.
 *
 * Domains without a glossary keep their existing behavior. Shipped domain
 * completeness is guarded separately by the production glossary coverage
 * test; this guard validates the refs whenever that contract exists.
 */
export function validateMetricRefsAgainstGlossary(
  packet: VerdictHandoffPacket,
  domain: EvalDomainRegistryEntry,
): HandlerError | null {
  const glossary = domain.metricGlossary;
  if (!glossary) return null;

  const missingRefs = packet.evidencePacket.metricRefs.filter(
    (ref) => !metricRefKeyCandidates(ref).some((candidate) => Object.hasOwn(glossary, candidate)),
  );
  if (missingRefs.length === 0) return null;

  return {
    status: 400,
    error: 'metric_refs_not_in_glossary',
    detail: `metricRefs must resolve against the '${packet.domainId}' glossary before publish: ${missingRefs.join(', ')}`,
  };
}
