import { loadDomains } from '../hub/eval-hub-read-model.js';
import type { VerdictGenerator } from '../publish-verdict/types.js';
import { generateTrajectoryInspectorLiveVerdict } from './eval-trajectory-inspector-live-verdict.js';
import type { TrajectoryInspectorSourceProvider } from './trajectory-inspector-source-provider.js';
import {
  type TrajectoryInspectorWindowSelector,
  validateTrajectoryInspectorWindowSelector,
} from './trajectory-inspector-types.js';

export function createTrajectoryInspectorGeneratorAdapter(
  provider: TrajectoryInspectorSourceProvider,
): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'trajectory-inspector-window') {
      throw new Error(`trajectory_inspector_adapter_wrong_kind: ${kind ?? '(omitted)'}`);
    }
    const validationError = validateTrajectoryInspectorWindowSelector(sourceRefs);
    if (validationError) throw new Error(`invalid_source_ref: ${validationError}`);
    if (!deps.ownerUserId) throw new Error('trajectory_inspector_owner identity unavailable');
    const selector = sourceRefs as TrajectoryInspectorWindowSelector;
    const episodeBundle = await provider.resolve(selector, { ownerUserId: deps.ownerUserId });
    const domain = loadDomains(deps.harnessFeedbackRoot).get(packet.domainId);
    if (!domain) throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    if (domain.domainId !== 'eval:trajectory-inspector') {
      throw new Error(`trajectory_inspector_adapter_wrong_domain: ${domain.domainId}`);
    }
    const artifact = generateTrajectoryInspectorLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      episodeBundle,
      submittedPacket: packet,
    });
    return { verdictPath: artifact.path, bundleDir: artifact.bundleDir };
  };
}
