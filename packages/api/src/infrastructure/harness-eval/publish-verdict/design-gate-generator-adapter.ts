import type { DesignGateEpisodeSourceProvider } from '../design-gate/design-gate-episode-source-provider.js';
import { validateDesignGateEpisodeSelector } from '../design-gate/design-gate-episode-source-provider.js';
import type { DesignGateEpisodeSourceSelector } from '../design-gate/design-gate-types.js';
import { generateDesignGateLiveVerdict } from '../design-gate/eval-design-gate-live-verdict.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import type { VerdictGenerator } from './types.js';

export function createDesignGateGeneratorAdapter(provider: DesignGateEpisodeSourceProvider): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'design-gate-episode-source-map') {
      throw new Error(`design_gate_adapter_wrong_kind: ${kind ?? '(omitted)'}`);
    }
    const selector = sourceRefs as DesignGateEpisodeSourceSelector;
    const validationError = validateDesignGateEpisodeSelector(selector);
    if (validationError) throw new Error(`invalid_source_ref: ${validationError}`);
    const episodeBundle = await provider.resolve(selector);
    const domain = loadDomains(deps.harnessFeedbackRoot).get(packet.domainId);
    if (!domain) throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    if (domain.domainId !== 'eval:design-gate') throw new Error(`design_gate_adapter_wrong_domain: ${domain.domainId}`);
    const artifact = generateDesignGateLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      episodeBundle,
      submittedPacket: packet,
    });
    return { verdictPath: artifact.path, bundleDir: artifact.bundleDir };
  };
}
