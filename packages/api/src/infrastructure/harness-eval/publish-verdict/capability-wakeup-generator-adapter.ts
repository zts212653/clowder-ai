import {
  type CapabilityWakeupSourceSelector,
  type CapabilityWakeupTrialProvider,
  validateCapabilityWakeupSelector,
} from '../capability-wakeup/capability-wakeup-trial-provider.js';
import { generateCapabilityWakeupLiveVerdict } from '../capability-wakeup/eval-capability-wakeup-live-verdict.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import type { VerdictGenerator } from './types.js';

/**
 * F192 Phase H 收尾 PR-2 (砚砚 R1 P1 + Q1) — capability-wakeup generator adapter.
 *
 * Mirrors a2a adapter shape but resolves its sources via TrialProvider replay/reclassify
 * (砚砚 R0 narrowing → R1 Q1):
 *   1. Discriminator check: sourceRefs.kind === 'capability-wakeup-trial-window'
 *      (rejects a2a refs / wrong selector kind early — handler dispatch + adapter
 *      sanity, no behaviour swap)
 *   2. validateCapabilityWakeupSelector (PR-1a's structural validator —
 *      capability non-empty, no newlines, window edges finite + ordered, etc.)
 *   3. provider.resolve(selector) → ClassifiedCapabilityWakeupTrial[]
 *   4. Load EvalDomainRegistryEntry from registry inside isolated harness root
 *      (registry is on origin/main, included in isolated worktree)
 *   5. generateCapabilityWakeupLiveVerdict with submittedPacket (砚砚 R8 P1: cat
 *      owns verdict; tool only overrides bundle refs)
 *
 * Adapter is constructed at bootstrap (index.ts) with a real `provider` —
 * production wires `CapabilityWakeupTrialProviderImpl`; tests can inject a stub.
 */
export function createCapabilityWakeupGeneratorAdapter(provider: CapabilityWakeupTrialProvider): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    // Discriminator check: route layer dispatches by domain, but defense-in-depth
    // catches misconfiguration (wrong kind for this generator).
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'capability-wakeup-trial-window') {
      throw new Error(
        `capability_wakeup_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'capability-wakeup-trial-window'`,
      );
    }
    const selector = sourceRefs as CapabilityWakeupSourceSelector;
    const validationError = validateCapabilityWakeupSelector(selector);
    if (validationError) {
      throw new Error(`invalid_source_ref: ${validationError}`);
    }
    if (selector.kind !== 'capability-wakeup-trial-window') {
      // Already narrowed by discriminator check above, but TS needs this for the narrowing below.
      throw new Error(`capability_wakeup_adapter_wrong_kind: unreachable after discriminator check`);
    }
    if (!deps.ownerUserId) {
      throw new Error('owner_user_required: capability-wakeup publish requires ownerUserId');
    }

    const trials = await provider.resolve(selector, { ownerUserId: deps.ownerUserId });
    if (trials.length === 0) {
      throw new Error(
        `no_trials_in_window: capability='${selector.capability}' window=[${selector.windowStartMs},${selector.windowEndMs}) sessionIds=[${selector.sessionIds?.join(',') ?? ''}] yielded zero classified trials`,
      );
    }

    const domains = loadDomains(deps.harnessFeedbackRoot);
    const domain = domains.get(packet.domainId);
    if (!domain) {
      throw new Error(`unknown_domain: ${packet.domainId} not in registry`);
    }

    const artifact = generateCapabilityWakeupLiveVerdict({
      verdictId: packet.id,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
      capability: selector.capability,
      trials,
      submittedPacket: packet,
    });

    // PR-2 R3 P1 (cloud): cw generator writes `trials.json` + `summary.json` at
    // `<repoRoot>/generated/capability-wakeup/<verdictId>/` (referenced by
    // provenance.json with sha256). Publisher MUST stage this dir or auto-PR
    // omits raw inputs and reviewers/main can't audit/replay the verdict.
    //
    // NOTE: `generated/capability-wakeup/` is .gitignored (.gitignore:209). The
    // FIX for that lives in `git-worktree-publisher.ts:71` (`git add -f --`) —
    // cloud R4/R5 keep flagging this line as if the fix should be here, but the
    // gitignore force-add is the publisher's responsibility. See R4 commit
    // `51c49c847` and R4 P1 comment in git-worktree-publisher.ts:66-70.
    return {
      verdictPath: artifact.path,
      bundleDir: artifact.bundleDir,
      extraStagedPaths: [artifact.rawInputDir],
    };
  };
}
