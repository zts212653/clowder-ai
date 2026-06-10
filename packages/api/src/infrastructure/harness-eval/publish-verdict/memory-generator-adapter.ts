import type { MemoryLibraryHealth, MemoryRecallMetrics } from '../eval-memory-adapter.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { generateMemoryLiveVerdict } from '../memory/eval-memory-live-verdict.js';
import type { MemoryRecallSourceSelector, VerdictGenerator } from './types.js';
import { validateMemoryRecallSelector } from './validation.js';

/**
 * F192 publish_verdict eval:memory wire-up — memory generator adapter.
 *
 * Mirrors `capability-wakeup-generator-adapter.ts` shape:
 *   1. Discriminator check: sourceRefs.kind === 'memory-recall-snapshot'
 *      (rejects a2a refs / cw selector early — defense-in-depth; handler
 *       normally guards this but adapter self-protects for non-handler callers)
 *   2. validateMemoryRecallSelector (structural validator — windowDays in
 *      [1, 90] integer, optional catId/toolName non-empty, no newlines)
 *   3. provider.resolve(selector) → {recallMetrics, libraryHealth}
 *   4. Load EvalDomainRegistryEntry from registry inside isolated harness root
 *      (registry is on origin/main, included in isolated worktree)
 *   5. generateMemoryLiveVerdict with submittedPacket (cat owns verdict;
 *      generator only overrides bundle refs in evidencePacket)
 *
 * Adapter is constructed at bootstrap (index.ts) with a real `provider` —
 * production wires a port backed by RecallMetricsComputer + computeLibraryHealth;
 * tests can inject a stub.
 */

export interface MemoryMetricsResolution {
  recallMetrics: MemoryRecallMetrics;
  libraryHealth: MemoryLibraryHealth;
}

export interface MemoryMetricsProvider {
  resolve(selector: MemoryRecallSourceSelector): Promise<MemoryMetricsResolution>;
}

export function createMemoryGeneratorAdapter(provider: MemoryMetricsProvider): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    // Discriminator check (defense-in-depth)
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'memory-recall-snapshot') {
      throw new Error(
        `memory_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'memory-recall-snapshot'`,
      );
    }
    const selector = sourceRefs as MemoryRecallSourceSelector;
    const validationError = validateMemoryRecallSelector(selector);
    if (validationError) {
      throw new Error(`invalid_source_ref: ${validationError}`);
    }

    const { recallMetrics, libraryHealth } = await provider.resolve(selector);

    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) {
      throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    }
    if (domain.domainId !== 'eval:memory') {
      throw new Error(`memory_adapter_wrong_domain: registry returned ${domain.domainId} for eval:memory packet`);
    }

    const artifact = generateMemoryLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      recallMetrics,
      libraryHealth,
      windowDays: selector.windowDays,
      filters: { catId: selector.catId, toolName: selector.toolName },
      submittedPacket: packet,
    });

    // memory generator writes `recall-metrics.json` + `library-health.json` at
    // `<repoRoot>/generated/memory/<verdictId>/` (referenced by provenance.json
    // with sha256). Publisher MUST stage this dir or auto-PR omits raw inputs
    // and reviewers/main can't audit/replay the verdict.
    return {
      verdictPath: artifact.path,
      bundleDir: artifact.bundleDir,
      extraStagedPaths: [artifact.rawInputDir],
    };
  };
}
