import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateA2aLiveVerdict } from '../a2a/eval-a2a-live-verdict.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { readA2aEvaluatorEvidence } from './a2a-evaluator-source.js';
import type { GeneratorDeps, VerdictGenerator } from './types.js';
import { isA2aSourceRefs, resolveSourceRefsInRoot, validateSourceRefsFormat } from './validation.js';
import type { A2aSnapshotAttributionRefs } from './verdict-source-types.js';

/**
 * F192 Phase H AC-H4 (砚砚 R4 P1 + cloud R4 P1) — refactored in PR-2 (砚砚 R1 Q1):
 * a2a adapter is now SELF-CONTAINED — handler passes raw sourceRefs + both roots
 * (live + isolated), adapter does ALL source resolution internally:
 *   1. Validate basename format (validateSourceRefsFormat)
 *   2. Resolve under the live root, or explicitly select the declared evaluator
 *      with exact checkout HEAD and two content hashes (no caller-supplied path)
 *   3. Copy raw evidence into ISOLATED worktree so generateA2aLiveVerdict's
 *      in-repo path invariant holds (provenance.relative() rejects outside-repo)
 *   4. Call generateA2aLiveVerdict with submittedPacket (砚砚 R8 P1: cat owns verdict)
 *
 * Encapsulating resolution here keeps publish-verdict.ts handler domain-agnostic.
 */
export function createA2aGeneratorAdapter(): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    // Discriminator check — adapter is only for a2a kind. Handler dispatches by domain,
    // but this guard catches misconfiguration / wrong-kind sourceRefs early.
    if (!isA2aSourceRefs(sourceRefs)) {
      throw new Error(
        `a2a_adapter_wrong_kind: createA2aGeneratorAdapter received sourceRefs with kind='${(sourceRefs as { kind?: string }).kind}'; expected omitted or 'a2a-snapshot-attribution'`,
      );
    }

    const refsCheck = validateSourceRefsFormat(sourceRefs);
    if (!refsCheck.ok) throw new Error(`invalid_source_ref: ${refsCheck.error.detail ?? 'unknown'}`);
    const snap = sourceRefs.snapshotName as string;
    const attr = sourceRefs.attributionName as string;

    if (sourceRefs.source && packet.domainId !== 'eval:a2a') {
      throw new Error('invalid_source_ref: designated evaluator is only available for eval:a2a');
    }
    const evidenceSource = await stageRawEvidence(sourceRefs, deps, snap, attr);

    // Load domain entry from registry inside the isolated worktree's harness root.
    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) throw new Error(`unknown_domain: ${packet.domainId} not in registry`);

    // 砚砚 R8 P1: pass submittedPacket so generator publishes CAT'S verdict
    // (not regenerated from evidence).
    const artifact = generateA2aLiveVerdict({
      verdictId: packet.id,
      rawSnapshotPath: resolve(deps.harnessFeedbackRoot, 'snapshots', snap),
      rawAttributionPath: resolve(deps.harnessFeedbackRoot, 'attributions', attr),
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      generatedAt: deps.publicationTime,
      submittedPacket: packet,
      ...(evidenceSource ? { evidenceSource } : {}),
    });

    return { verdictPath: artifact.path, bundleDir: artifact.bundleDir };
  };
}

async function stageRawEvidence(refs: A2aSnapshotAttributionRefs, deps: GeneratorDeps, snap: string, attr: string) {
  const isoSnapDir = resolve(deps.harnessFeedbackRoot, 'snapshots');
  const isoAttrDir = resolve(deps.harnessFeedbackRoot, 'attributions');
  if (refs.source) {
    const evidence = await readA2aEvaluatorEvidence(deps.liveHarnessFeedbackRoot, snap, attr, refs.source);
    mkdirSync(isoSnapDir, { recursive: true });
    mkdirSync(isoAttrDir, { recursive: true });
    writeFileSync(resolve(isoSnapDir, snap), evidence.snapshot);
    writeFileSync(resolve(isoAttrDir, attr), evidence.attribution);
    return evidence.provenance;
  }
  const liveRefs = resolveSourceRefsInRoot(deps.liveHarnessFeedbackRoot, snap, attr);
  if (!liveRefs.ok) throw new Error(`invalid_source_ref: ${liveRefs.reason}`);
  if (!existsSync(liveRefs.refs.snapshotPath) || !existsSync(liveRefs.refs.attributionPath)) {
    throw new Error('evidence_not_found: sourceRefs not found in live harness-feedback');
  }
  mkdirSync(isoSnapDir, { recursive: true });
  mkdirSync(isoAttrDir, { recursive: true });
  copyFileSync(liveRefs.refs.snapshotPath, resolve(isoSnapDir, snap));
  copyFileSync(liveRefs.refs.attributionPath, resolve(isoAttrDir, attr));
  return undefined;
}
