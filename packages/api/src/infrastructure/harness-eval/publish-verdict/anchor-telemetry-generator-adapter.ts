import type { AnchorTelemetryRollup } from '../../../routes/anchor-event-log.js';
import { generateAnchorFirstLiveVerdict } from '../anchor-first/eval-anchor-first-live-verdict.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import type { AnchorTelemetrySourceSelector, VerdictGenerator } from './types.js';
import { validateAnchorTelemetrySelector } from './validation.js';

/**
 * F236 Track-2 AC-E4 — anchor-telemetry generator adapter (publish_verdict eval:anchor-first).
 *
 * Mirrors `friction-generator-adapter.ts` shape:
 *   1. Discriminator: sourceRefs.kind === 'anchor-telemetry-snapshot' (defense-in-depth)
 *   2. validateAnchorTelemetrySelector (window finite + ordered)
 *   3. provider.resolve(selector) -> AnchorTelemetryRollup (live rollup)
 *   4. Load EvalDomainRegistryEntry from registry inside isolated harness root
 *   5. generateAnchorFirstLiveVerdict with submittedPacket (cat owns the verdict;
 *      generator only overrides bundle refs in evidencePacket)
 *
 * No writeback (no afterPublish side effect, no extraStagedPaths). Bundle-only
 * output: raw rollup lives under bundleDir/raw/.
 */

export interface AnchorTelemetryMetricsProvider {
  resolve(selector: AnchorTelemetrySourceSelector): Promise<AnchorTelemetryRollup>;
}

export function createAnchorTelemetryGeneratorAdapter(provider: AnchorTelemetryMetricsProvider): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'anchor-telemetry-snapshot') {
      throw new Error(
        `anchor_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'anchor-telemetry-snapshot'`,
      );
    }
    const selector = sourceRefs as AnchorTelemetrySourceSelector;
    const validationError = validateAnchorTelemetrySelector(selector);
    if (validationError) {
      throw new Error(`invalid_source_ref: ${validationError}`);
    }

    const rollup = await provider.resolve(selector);

    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) {
      throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    }
    if (domain.domainId !== 'eval:anchor-first') {
      throw new Error(`anchor_adapter_wrong_domain: registry returned ${domain.domainId} for eval:anchor-first packet`);
    }

    const artifact = generateAnchorFirstLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      rollup,
      selector,
      submittedPacket: packet,
    });

    // Bundle-only: raw rollup under bundleDir/raw/, no extraStagedPaths.
    return {
      verdictPath: artifact.path,
      bundleDir: artifact.bundleDir,
    };
  };
}
