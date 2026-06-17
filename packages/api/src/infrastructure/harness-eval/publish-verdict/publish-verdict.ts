import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CapabilityWakeupSourceSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import { validateCapabilityWakeupSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';
import { mapPublishVerdictError } from './error-mapping.js';
import { computePublishPolicy } from './publish-policy.js';
import type {
  GitPublisher,
  HandlerError,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictSuccess,
  VerdictGenerator,
} from './types.js';
import {
  assertNoNewlineInBulletFields,
  inferSourceRefsKind,
  isA2aSourceRefs,
  isMemorySourceRefs,
  isSopSourceRefs,
  isTaskOutcomeSourceRefs,
  validateMemoryRecallSelector,
  validateSopTraceSelector,
  validateSourceRefsFormat,
  validateTaskOutcomeSourceRefs,
} from './validation.js';

export type {
  GitPublisher,
  HandlerError,
  PublishOnIsolatedWorktreeOpts,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictSuccess,
  ResolvedSourceRefs,
  StageResult,
  VerdictGenerator,
  VerdictSourceRefs,
} from './types.js';

// AC-H8: length + slug + idempotency (复用 generate-now 模式)
const MAX_VERDICT_ID_LEN = 128;
const MAX_PHENOMENON_LEN = 2048;
const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;

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
): Promise<PublishVerdictSuccess | HandlerError> {
  // AC-H1: validate full packet schema
  let packet: VerdictHandoffPacket;
  try {
    packet = parseVerdictHandoffPacket(input.packet);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, error: 'invalid_packet', detail: message };
  }

  // AC-H7 partial: cross-check input.domain ↔ packet.domainId (consistency guard)
  if (input.domain !== packet.domainId) {
    return {
      status: 400,
      error: 'domain_mismatch',
      detail: `input.domain '${input.domain}' does not match packet.domainId '${packet.domainId}'`,
    };
  }

  // 砚砚 R11 P1 + AC-H1: completeness — schema validates "array", guard checks
  // "non-empty". Cat owns metric/trace refs (NOT bundle-overridden); reject early
  // before invoking generator if cat omitted them. snapshot/attribution placeholders
  // also checked here (will be overridden by bundle but cat must still send shape).
  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    return { status: 400, error: 'handoff_incomplete', detail: `handoff_incomplete: ${handoffDecision.reason}` };
  }

  // 砚砚 R18 P2 + cloud R18 P2: reject \r\n in fields renderer writes as single-line
  // bullets (read-model regex parses first line — newline truncates + enables injection).
  const newlineError = assertNoNewlineInBulletFields(packet);
  if (newlineError) return newlineError;

  // AC-H3 + 砚砚 R6 P1: catId from callback auth (MCP layer). Domain allowlist
  // respects OQ-20 Redis override (symmetric with trigger-now), else static registry.
  if (!input.catId) {
    return {
      status: 401,
      error: 'unauthenticated',
      detail: 'catId not provided — MCP layer must derive from callback',
    };
  }
  const domains = loadDomains(deps.harnessFeedbackRoot);
  const domainEntry = domains.get(packet.domainId as Parameters<typeof domains.get>[0]);
  if (!domainEntry) {
    return {
      status: 400,
      error: 'domain_not_registered',
      detail: `Domain '${packet.domainId}' not found in eval-domains/ registry`,
    };
  }
  // 砚砚 R6 P1: prefer Redis override if set, fallback to static registry cat
  let allowedCatId = domainEntry.evalCat.catId as string;
  let overrideApplied = false;
  if (deps.redis) {
    try {
      const override = await getEvalCatOverride(deps.redis, packet.domainId);
      if (override) {
        allowedCatId = override.catId;
        overrideApplied = true;
      }
    } catch {
      // Redis read failure: fall back to static cat (safer than open-fail)
    }
  }
  if (input.catId !== allowedCatId) {
    return {
      status: 403,
      error: 'not_allowed',
      detail: `catId '${input.catId}' is not the eval cat for domain '${packet.domainId}' (expected '${allowedCatId}'${overrideApplied ? ' via OQ-20 Redis override' : ' from registry'})`,
    };
  }

  // AC-H8: length + slug + idempotency (复用 generate-now 模式)
  if (packet.id.length > MAX_VERDICT_ID_LEN) {
    return {
      status: 400,
      error: 'invalid_packet_id',
      detail: `packet.id must be <= ${MAX_VERDICT_ID_LEN} chars (got ${packet.id.length})`,
    };
  }
  if (!SAFE_VERDICT_ID.test(packet.id)) {
    return {
      status: 400,
      error: 'invalid_packet_id',
      detail: `packet.id must match safe slug pattern /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric + hyphens, no leading hyphen). Got: '${packet.id}'`,
    };
  }
  if (packet.phenomenon.length > MAX_PHENOMENON_LEN) {
    return {
      status: 400,
      error: 'invalid_packet',
      detail: `packet.phenomenon must be <= ${MAX_PHENOMENON_LEN} chars (got ${packet.phenomenon.length})`,
    };
  }
  // Idempotency fast-fail: live-tree existsSync catches common dup quickly.
  // 砚砚 R3 P1 #2 cloud: NOT authoritative — if API checkout is stale vs origin/main,
  // dup-on-main slips through. Authoritative re-check inside isolated worktree below.
  const liveVerdictPath = resolve(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
  const liveBundleDir = resolve(deps.harnessFeedbackRoot, 'bundles', packet.id);
  if (existsSync(liveVerdictPath) || existsSync(liveBundleDir)) {
    return {
      status: 409,
      error: 'verdict_already_exists',
      detail: `packet.id '${packet.id}' already has a verdict file or bundle directory in the live worktree. Pick a different id — overwriting existing Eval Hub evidence is forbidden (data integrity).`,
    };
  }

  // PR-2 (砚砚 R1 P1): handler pre-validates sourceRefs shape per kind for proper
  // 4xx error codes. Adapter-level validation is defense-in-depth (catches when
  // generator called outside handler flow), but user-facing validation lives here.
  //
  // cloud R8 P2 (PR-2): cross-check sourceRefs.kind ↔ packet.domainId BEFORE
  // per-kind validation. Wrong-shape input for a supported domain (e.g. a2a refs
  // sent for capability-wakeup domain, or cw selector sent for a2a domain) is
  // user-correctable; rejecting at 400 here is better UX than letting it
  // dispatch to adapter → throw `*_adapter_wrong_kind` → 500 generator_failed.
  const refsKind = inferSourceRefsKind(input.sourceRefs);
  const EXPECTED_REFS_KIND_BY_DOMAIN: Partial<Record<string, string>> = {
    'eval:a2a': 'a2a-snapshot-attribution',
    'eval:capability-wakeup': 'capability-wakeup-trial-window',
    'eval:sop': 'sop-trace-eval',
    'eval:task-outcome': 'task-outcome-snapshot',
    'eval:memory': 'memory-recall-snapshot',
  };
  const expectedKind = EXPECTED_REFS_KIND_BY_DOMAIN[packet.domainId];
  if (expectedKind && expectedKind !== refsKind) {
    return {
      status: 400,
      error: 'sourceRefs_kind_mismatch',
      detail: `Domain '${packet.domainId}' expects sourceRefs.kind='${expectedKind}', got '${refsKind}'. Each domain has a specific evidence shape: eval:a2a → {snapshotName, attributionName}; eval:capability-wakeup → {kind:'capability-wakeup-trial-window', ...}; eval:memory → {kind:'memory-recall-snapshot', ...}; eval:sop → {kind:'sop-trace-eval', sopDefinitionId, trace}; eval:task-outcome → {kind:'task-outcome-snapshot', ...}.`,
    };
  }

  if (isSopSourceRefs(input.sourceRefs)) {
    const selectorError = validateSopTraceSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isMemorySourceRefs(input.sourceRefs)) {
    const selectorError = validateMemoryRecallSelector(input.sourceRefs);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
  } else if (isA2aSourceRefs(input.sourceRefs)) {
    const refsCheck = validateSourceRefsFormat(input.sourceRefs);
    if (!refsCheck.ok) return refsCheck.error;
  } else if (isTaskOutcomeSourceRefs(input.sourceRefs)) {
    const refsCheck = validateTaskOutcomeSourceRefs(input.sourceRefs);
    if (!refsCheck.ok) return refsCheck.error;
  } else {
    const cwSelector = input.sourceRefs as unknown as CapabilityWakeupSourceSelector;
    // PR-1a structural validator (capability non-empty / no newlines / window edges finite + ordered).
    const selectorError = validateCapabilityWakeupSelector(cwSelector);
    if (selectorError) return { status: 400, error: 'invalid_source_ref', detail: selectorError };
    // trial-ids selector remains unsupported until a durable trial store ships.
    // Window selectors may omit sessionIds: provider resolves an unbiased runtime-session
    // window scan when production wires SessionWindowEnumerator.
    if (cwSelector.kind !== 'capability-wakeup-trial-window') {
      return {
        status: 400,
        error: 'invalid_source_ref',
        detail: `PR-2 wired only 'capability-wakeup-trial-window' kind for capability-wakeup domain (got '${cwSelector.kind}'; trial-ids selector reserved for future durable trial store PR)`,
      };
    }
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

  let artifact: {
    verdictPath: string;
    bundleDir: string;
    extraStagedPaths?: string[];
    afterPublish?: () => void | Promise<void>;
  } | null = null;
  try {
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
        artifact = await generator(packet, input.sourceRefs, {
          harnessFeedbackRoot: isolatedHarnessFeedback,
          liveHarnessFeedbackRoot: deps.harnessFeedbackRoot,
          ownerUserId: input.ownerUserId,
          taskOutcomeDbPath: deps.taskOutcomeDbPath,
          eventMemoryDbPath: deps.eventMemoryDbPath,
        });
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
          paths: [artifact.verdictPath, artifact.bundleDir, ...(artifact.extraStagedPaths ?? [])],
          commitMessage: `verdict(${packet.domainId}): ${packet.id} — ${packet.verdict}\n\n${packet.phenomenon}\n\n[published via cat_cafe_publish_verdict MCP]`,
          prTitle: `verdict(${packet.domainId}): ${packet.id}`,
          prBody: `Verdict published via cat_cafe_publish_verdict MCP tool.\n\nVerdict: ${packet.verdict}\nDomain: ${packet.domainId}\nPhenomenon: ${packet.phenomenon}\n\nReviewed by: ${packet.ownerAsk.targetOwnerCatId}\nAction: ${packet.ownerAsk.requestedAction}${policyFooter}`,
          labels: policy.labels,
          afterPublish: artifact.afterPublish,
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const mapped = mapPublishVerdictError(message);
    if (mapped) return mapped;
    if (!artifact) return { status: 500, error: 'generator_failed', detail: message };
    return { status: 500, error: 'git_or_gh_failed', detail: message };
  }
}
