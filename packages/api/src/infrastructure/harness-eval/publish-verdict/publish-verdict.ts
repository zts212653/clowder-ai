import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertMeasurementVerdictActionAllowed } from '../measurement/measurement-bundle-census.js';
import {
  ensureMeasurementBundleCensusFile,
  refreshMeasurementBundleCensusFile,
} from '../measurement/measurement-bundle-census-file.js';
import { mapPublishVerdictError } from './error-mapping.js';
import {
  generatedArtifactStagePaths,
  writeGeneratedLifecycleArtifacts,
} from './friction-findings/generated-lifecycle-artifacts.js';
import { fetchAndCreateMainReader, resolveRepoRoot } from './publication/replay-detection.js';
import { verdictEvidenceContractSuccessStatuses } from './publication/verdict-commit-status-publisher.js';
import { computePublishPolicy } from './publish-policy.js';
import { resolvePostPublishCollision, resolvePrePublishReplay } from './replay-orchestration.js';
import type {
  GeneratedFindingArtifact,
  GeneratedVerdictArtifact,
  GitPublisher,
  HandlerError,
  PublishedVerdictChildArtifact,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictNoNewWindow,
  PublishVerdictSuccess,
  VerdictGenerator,
} from './types.js';
import { validatePublishInput } from './validate-publish-input.js';

/**
 * F192 Phase H — Verdict Publishing Pipeline (砚砚 R0 Path B narrowed).
 * Eval cat calls cat_cafe_publish_verdict MCP → handler validates → generator
 * runs INSIDE isolated worktree (砚砚 R1 P1 #1 + R7 cloud: live tree NEVER touched)
 * → GitPublisher commits + pushes + opens auto-PR. Replaces PR #2091.
 */

const defaultGitPublisher: GitPublisher = {
  async publishOnIsolatedWorktree() {
    throw new Error('GitPublisher not injected (must wire real isolated-worktree impl at route layer)');
  },
};

/**
 * AC-H1: Validate VerdictHandoffPacket schema (server NEVER 造 evidence).
 * AC-H7 partial: input.domain must match packet.domainId.
 * AC-H2: call generator → branch + commit + push + auto-PR → return SHA + URL.
 *
 * F192 Phase H 收尾 PR-2 (砚砚 R1 P1): handler is now domain-agnostic.
 *   - Replaced hardcoded `packet.domainId !== 'eval:a2a'` check with
 *     `if (!deps.generator) → 501` (route-layer dispatches single generator per domain
 *     via `eval-hub.ts opts.verdictGenerators[domainId]`)
 *   - Removed a2a-specific source resolution from stage callback (a2a adapter
 *     handles its own resolve+copy; cw adapter calls provider.resolve internally)
 */
export async function handlePublishVerdict(
  deps: PublishVerdictDeps,
  input: PublishVerdictInput,
): Promise<PublishVerdictSuccess | PublishVerdictNoNewWindow | HandlerError> {
  // --- Input validation (extracted to validate-publish-input.ts for 350-line cap) ---
  const validated = await validatePublishInput(deps, input);
  if ('status' in validated) return validated;
  const { packet, analysisFindings, publicationTime } = validated;

  // --- Replay detection (R7: centralized canonical authority) ---
  //
  // All no_new_window decisions are centralized in replay-orchestration.ts.
  // Success requires canonical proof from fresh origin/main + source identity.
  // Live-tree state alone is never sufficient for typed success when replay
  // infrastructure (source verification) is present.
  //
  // R5 P1-3: FreshMainReader only created for domains with replay resolvers.
  const repoRootForRefresh =
    (!deps.mainReader || !deps.createFreshMainReader) && (deps.replayPreflight || deps.checkStoredSourceEquivalence)
      ? await resolveRepoRoot(deps.harnessFeedbackRoot, { signal: deps.signal })
      : null;
  const createFreshMainReader =
    deps.createFreshMainReader ??
    (repoRootForRefresh
      ? async () => (await fetchAndCreateMainReader(repoRootForRefresh, { signal: deps.signal })) ?? undefined
      : undefined);
  const mainReader =
    deps.mainReader ??
    (repoRootForRefresh
      ? ((await fetchAndCreateMainReader(repoRootForRefresh, { signal: deps.signal })) ?? undefined)
      : undefined);

  const replayCtx = {
    mainReader,
    createFreshMainReader,
    harnessFeedbackRoot: deps.harnessFeedbackRoot,
    domainId: packet.domainId,
    replayPreflight: deps.replayPreflight,
    checkStoredSourceEquivalence: deps.checkStoredSourceEquivalence,
  };

  const prePublish = await resolvePrePublishReplay(packet.id, input.sourceRefs, replayCtx);
  if (prePublish.outcome === 'replay') {
    return { ok: true, outcome: 'no_new_window', canonicalVerdictId: prePublish.canonicalVerdictId };
  }
  if (prePublish.outcome === 'conflict') {
    return prePublish.error;
  }

  // PR-2 (砚砚 R1 P1): route layer dispatches per-domain generator from
  // `opts.verdictGenerators?.[domainId]` → if undefined, no generator wired → 501.
  // (Old hardcoded `domainId !== 'eval:a2a'` check removed; route layer is now SoT.)
  if (!deps.generator) {
    return {
      status: 501,
      error: 'unsupported_generator',
      detail: `Domain '${packet.domainId}' has no live-verdict generator wired. Wire via opts.verdictGenerators in eval-hub.ts route registration.`,
    };
  }

  // AC-H2: delegate isolated-worktree lifecycle to GitPublisher.
  // Generator runs inside the isolated worktree; live harnessFeedbackRoot is never mutated.
  // Branch uniqueness/race protection is delegated to git worktree add -b.
  // PR-2: stage callback stays domain-agnostic; adapters resolve their own sources.
  const gitPublisher = deps.gitPublisher ?? defaultGitPublisher;
  const generator: VerdictGenerator = deps.generator; // checked above (501 if missing)
  const domainSlug = packet.domainId.replace(/:/g, '-');
  const branchName = `verdict/auto/${domainSlug}/${packet.id}`;

  let artifact: GeneratedVerdictArtifact | null = null;
  let findingArtifacts: GeneratedFindingArtifact[] = [];
  let childArtifacts: PublishedVerdictChildArtifact[] = [];
  try {
    deps.signal?.throwIfAborted();
    const { commitSha, prUrl } = await gitPublisher.publishOnIsolatedWorktree({
      branchName,
      sourceBase: 'origin/main',
      async stage(worktreeRoot) {
        const isolatedHarnessFeedback = `${worktreeRoot}/docs/harness-feedback`;
        // 砚砚 R3 P1 #2 cloud: AUTHORITATIVE dup check (origin/main truth).
        const isoVerdictPath = resolve(isolatedHarnessFeedback, 'verdicts', `${packet.id}.md`);
        const isoBundleDir = resolve(isolatedHarnessFeedback, 'bundles', packet.id);
        if (existsSync(isoVerdictPath) || existsSync(isoBundleDir)) {
          throw new Error(
            `verdict_already_exists_on_main: packet.id '${packet.id}' already exists on origin/main. Pick a different id.`,
          );
        }
        // Freeze reviewed census metadata before the generator receives write access
        // to the isolated harness root; only publisher-derived fields may change.
        const cleanCensusSource = ensureMeasurementBundleCensusFile(worktreeRoot, packet.createdAt).source;
        assertMeasurementVerdictActionAllowed(parseYaml(cleanCensusSource), packet.domainId, packet.verdict);
        const generatedArtifact = await generator(packet, input.sourceRefs, {
          harnessFeedbackRoot: isolatedHarnessFeedback,
          liveHarnessFeedbackRoot: deps.harnessFeedbackRoot,
          publicationTime,
          ownerUserId: input.ownerUserId,
          taskOutcomeDbPath: deps.taskOutcomeDbPath,
          eventMemoryDbPath: deps.eventMemoryDbPath,
          ...(analysisFindings ? { analysisFindings } : {}),
        });
        childArtifacts = writeGeneratedLifecycleArtifacts(generatedArtifact, packet, isolatedHarnessFeedback);

        // Stamp invocation-authenticated sourceThreadId into provenance.json.
        // Centralized here (not in 10+ generators) so: (a) new generators get it
        // for free, (b) client can never forge it — it comes from CallbackPrincipal.
        // agent_key principals have no threadId, so the field is omitted gracefully.
        if (input.sourceThreadId) {
          const provenancePath = join(generatedArtifact.bundleDir, 'provenance.json');
          if (existsSync(provenancePath)) {
            const prov = JSON.parse(readFileSync(provenancePath, 'utf8'));
            prov.sourceThreadId = input.sourceThreadId;
            writeFileSync(provenancePath, `${JSON.stringify(prov, null, 2)}\n`);
          } else {
            console.warn(
              `[publish-verdict] provenance.json not found at ${provenancePath}, sourceThreadId not stamped — generator may have failed to produce it`,
            );
          }
        }

        const refreshedCensusPath = refreshMeasurementBundleCensusFile(
          worktreeRoot,
          packet.createdAt,
          cleanCensusSource,
        );
        artifact = generatedArtifact;
        findingArtifacts = generatedArtifact.findingArtifacts ?? [];
        // PR-3 (砚砚 R2): read attribution.json from bundle to compute publish policy.
        // Generator writes attribution.json into bundleDir; if absent or parse fails,
        // `computePublishPolicy` fail-opens to regular_pr (砚砚 R2 contract).
        let attribution: unknown;
        try {
          const attrPath = resolve(artifact.bundleDir, 'attribution.json');
          if (existsSync(attrPath)) {
            attribution = JSON.parse(readFileSync(attrPath, 'utf8'));
          }
        } catch {
          // Fail-open: undefined → computePublishPolicy returns regular_pr
        }
        const policy = computePublishPolicy(packet, attribution);
        const policyFooter =
          policy.mode === 'evidence_only_interim_pr'
            ? `\n\n---\n**Cat-owned artifact gate — No operator merge needed.**\n(Interim: keep_observe + no actionable findings. Rollup mechanism deferred to future Phase. See docs/SOP.md § artifact-only-pr-merge-gate for cat merge contract.)`
            : policy.labels.includes('evidence-only')
              ? `\n\n---\n**Cat-owned artifact gate — No operator merge needed.**\n(Actionable findings present; eval domain owner cat merges per docs/SOP.md § artifact-only-pr-merge-gate.)`
              : '';
        return {
          // PR-2 R3 P1 (cloud): stage extra paths the generator wrote (cw raw inputs)
          // so the auto-PR includes all evidence referenced by provenance.json.
          paths: [...generatedArtifactStagePaths(generatedArtifact), refreshedCensusPath],
          commitMessage: `verdict(${packet.domainId}): ${packet.id} — ${packet.verdict}\n\n${packet.phenomenon}\n\n[published via cat_cafe_publish_verdict MCP]`,
          prTitle: `verdict(${packet.domainId}): ${packet.id}`,
          prBody: `Verdict published via cat_cafe_publish_verdict MCP tool.\n\nVerdict: ${packet.verdict}\nDomain: ${packet.domainId}\nPhenomenon: ${packet.phenomenon}\n\nReviewed by: ${packet.ownerAsk.targetOwnerCatId}\nAction: ${packet.ownerAsk.requestedAction}${input.sourceThreadId ? `\nSource thread: ${input.sourceThreadId}` : ''}${policyFooter}`,
          labels: policy.labels,
          statusChecks: verdictEvidenceContractSuccessStatuses(),
          afterPublish: generatedArtifact.afterPublish,
        };
      },
    });

    // Stage must have produced artifact (proves generator ran in isolated worktree)
    if (!artifact) {
      return { status: 500, error: 'internal', detail: 'stage callback did not produce artifact' };
    }
    // 砚砚 R12 P2 cloud: returned paths are REPO-RELATIVE (resolve under origin/main
    // post-merge), NOT the generator's absolute paths inside the temp worktree which
    // is removed in finally — those would be dangling references at response time.
    return {
      ok: true,
      verdictPath: `docs/harness-feedback/verdicts/${packet.id}.md`,
      bundleDir: `docs/harness-feedback/bundles/${packet.id}`,
      commitSha,
      prUrl,
      findingArtifacts,
      childArtifacts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // --- Layer 2: Catch-block replay intercepts (R7: centralized authority) ---
    // Delegates to replay-orchestration for canonical authority enforcement.
    const collision = await resolvePostPublishCollision(message, packet.id, input.sourceRefs, replayCtx);
    if (collision?.outcome === 'replay') {
      return { ok: true, outcome: 'no_new_window', canonicalVerdictId: collision.canonicalVerdictId };
    }
    const mapped = mapPublishVerdictError(message);
    if (mapped) return mapped;
    if (!artifact) return { status: 500, error: 'generator_failed', detail: message };
    return { status: 500, error: 'git_or_gh_failed', detail: message };
  }
}
