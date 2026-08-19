import { generateFreshnessLiveVerdict } from '../freshness/eval-freshness-live-verdict.js';
import type { FreshnessReplayProvider } from '../freshness/freshness-replay-provider.js';
import type { FreshnessReplaySelector } from '../freshness/freshness-replay-types.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import type { VerdictGenerator } from './types.js';
import { validateFreshnessReplaySelector } from './validation.js';

export function createFreshnessGeneratorAdapter(provider: FreshnessReplayProvider): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'freshness-closure-replay') {
      throw new Error(`freshness_adapter_wrong_kind: ${kind ?? '(omitted)'}`);
    }
    const selector = sourceRefs as FreshnessReplaySelector;
    const validationError = validateFreshnessReplaySelector(selector);
    if (validationError) throw new Error(`invalid_source_ref: ${validationError}`);
    const replay = await provider.resolve(selector);
    const domain = loadDomains(deps.harnessFeedbackRoot).get(packet.domainId);
    if (!domain) throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    if (domain.domainId !== 'eval:freshness') {
      throw new Error(`freshness_adapter_wrong_domain: ${domain.domainId}`);
    }
    const artifact = generateFreshnessLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      replay,
      submittedPacket: packet,
    });
    return { verdictPath: artifact.path, bundleDir: artifact.bundleDir };
  };
}
