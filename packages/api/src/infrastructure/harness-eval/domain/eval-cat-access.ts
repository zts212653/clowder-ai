import type { Redis } from 'ioredis';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { getEvalCatOverride } from './eval-domain-override.js';
import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';

export type EvalCatAccessPolicy =
  | { registered: false }
  | {
      registered: true;
      domain: EvalDomainRegistryEntry;
      allowedCatId: string;
      overrideApplied: boolean;
    };

/**
 * Resolve the one cat currently authorized to act as a domain evaluator.
 * Static registry identity is canonical unless an OQ-20 Redis override exists.
 * Redis read failures preserve the existing publish behavior and fall back to
 * the static identity instead of opening access to arbitrary callers.
 */
export async function resolveEvalCatAccessPolicy(
  deps: { harnessFeedbackRoot: string; redis?: Redis },
  domainId: string,
): Promise<EvalCatAccessPolicy> {
  const domains = loadDomains(deps.harnessFeedbackRoot);
  const domainEntry = domains.get(domainId as Parameters<typeof domains.get>[0]);
  if (!domainEntry) return { registered: false };

  let allowedCatId = domainEntry.evalCat.catId as string;
  let overrideApplied = false;
  if (deps.redis) {
    try {
      const override = await getEvalCatOverride(deps.redis, domainId);
      if (override) {
        allowedCatId = override.catId;
        overrideApplied = true;
      }
    } catch {
      // Keep publish/read authorization symmetric: Redis outage falls back to static registry identity.
    }
  }
  return { registered: true, domain: domainEntry, allowedCatId, overrideApplied };
}
