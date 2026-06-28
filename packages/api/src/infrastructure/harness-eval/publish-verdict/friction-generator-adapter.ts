import type { FrictionRollupInput, FrictionRollupSourceSelector } from '@cat-cafe/shared';
import { generateFrictionLiveVerdict } from '../friction/eval-friction-live-verdict.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import type { VerdictGenerator } from './types.js';
import { validateFrictionRollupSelector } from './validation.js';

/**
 * F245 Phase C PR1b — friction generator adapter (publish_verdict eval:friction).
 *
 * Mirrors `memory-generator-adapter.ts` shape:
 *   1. Discriminator: sourceRefs.kind === 'friction-rollup-snapshot' (rejects a2a /
 *      other selectors early — defense-in-depth; handler normally guards but the
 *      adapter self-protects for non-handler callers)
 *   2. validateFrictionRollupSelector (window finite + ordered, topN/tokenCap
 *      positive int)
 *   3. provider.resolve(selector) → FrictionRollupInput (live 4-channel rollup)
 *   4. Load EvalDomainRegistryEntry from registry inside isolated harness root
 *   5. generateFrictionLiveVerdict with submittedPacket (Decision 3: cat owns the
 *      verdict; generator only overrides bundle refs in evidencePacket)
 *
 * KD-4: the friction generator performs NO writeback (no afterPublish side effect,
 * unlike task-outcome's episode verdict writeback). Bundle-only output → no
 * extraStagedPaths (Decision 2: raw report lives under bundleDir/raw/).
 */

export interface FrictionMetricsProvider {
  resolve(selector: FrictionRollupSourceSelector): Promise<FrictionRollupInput>;
}

export function createFrictionGeneratorAdapter(provider: FrictionMetricsProvider): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'friction-rollup-snapshot') {
      throw new Error(
        `friction_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'friction-rollup-snapshot'`,
      );
    }
    const selector = sourceRefs as FrictionRollupSourceSelector;
    const validationError = validateFrictionRollupSelector(selector);
    if (validationError) {
      throw new Error(`invalid_source_ref: ${validationError}`);
    }

    const rollupInput = await provider.resolve(selector);

    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) {
      throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    }
    if (domain.domainId !== 'eval:friction') {
      throw new Error(`friction_adapter_wrong_domain: registry returned ${domain.domainId} for eval:friction packet`);
    }

    const artifact = generateFrictionLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      rollupInput,
      selector,
      submittedPacket: packet,
    });

    // Bundle-only: the raw rollup report is written under bundleDir/raw/, so the
    // publisher stages it via `bundleDir` — no extraStagedPaths needed.
    return {
      verdictPath: artifact.path,
      bundleDir: artifact.bundleDir,
    };
  };
}
