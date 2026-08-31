import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import { assertMeasurementVerdictActionAllowed } from '../measurement/measurement-bundle-census.js';
import { readMeasurementBundleCensusFile } from '../measurement/measurement-bundle-census-file.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';
import { mapPublishVerdictError } from './error-mapping.js';
import { writeLifecycleRootArtifact } from './lifecycle-root-artifact.js';
import { validateMetricRefsAgainstGlossary } from './metric-glossary-validation.js';
import { computePublishPolicy } from './publish-policy.js';
import { validateSourceRefsForPublish } from './source-ref-handler-validation.js';
import type {
  ArtifactPublisher,
  HandlerError,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictSuccess,
  VerdictGenerator,
} from './types.js';
import { assertNoNewlineInBulletFields, inferSourceRefsKind, isKnownSourceRefsKind } from './validation.js';

export type {
  ArtifactPublisher,
  ArtifactRef,
  HandlerError,
  PublishArtifactOpts,
  PublishVerdictDeps,
  PublishVerdictInput,
  PublishVerdictSuccess,
  ResolvedSourceRefs,
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
 * writes an immutable bundle through the local ArtifactPublisher. Git/PR writeback
 * is intentionally not part of the F257 runtime contract.
 */

const defaultArtifactPublisher: ArtifactPublisher = {
  async publishArtifact() {
    throw new Error('ArtifactPublisher not injected (must wire real durable publisher at route layer)');
  },
};

/**
 * AC-H1: Validate VerdictHandoffPacket schema (server NEVER 造 evidence).
 * AC-H7 partial: input.domain must match packet.domainId.
 * AC-H2 (F257 sunset): call generator → atomically persist artifact → return artifact identity and paths.
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

  const metricRefsError = validateMetricRefsAgainstGlossary(packet, domainEntry);
  if (metricRefsError) return metricRefsError;

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
  const expectedKind = domainEntry.sourceRefsKind;
  if (expectedKind && expectedKind !== refsKind) {
    return {
      status: 400,
      error: 'sourceRefs_kind_mismatch',
      detail: `Domain '${packet.domainId}' expects sourceRefs.kind='${expectedKind}', got '${refsKind}'. Registry sourceRefsKind is the contract; explicit validator/generator wiring must still exist for the domain to publish.`,
    };
  }
  if (!isKnownSourceRefsKind(refsKind)) {
    return {
      status: 501,
      error: 'unsupported_source_refs_kind',
      detail: `Domain '${packet.domainId}' declares sourceRefs.kind='${refsKind}', but publish-verdict has no validator wiring for that selector kind yet. Add explicit validator/generator wiring before using this kind.`,
    };
  }

  const sourceRefsError = validateSourceRefsForPublish(input.sourceRefs);
  if (sourceRefsError) return sourceRefsError;

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

  // F257 / F192 sunset: runtime verdicts are durable artifacts, not product-repo PRs.
  const artifactPublisher = deps.artifactPublisher ?? defaultArtifactPublisher;
  const generator: VerdictGenerator = deps.generator; // checked above (501 if missing)

  let generated: {
    verdictPath: string;
    bundleDir: string;
    extraStagedPaths?: string[];
    afterPublish?: () => void | Promise<void>;
  } | null = null;
  try {
    // Preserve main's measurement-policy gate. The census remains a product-repo
    // input; local artifact publication must not rewrite that repository file.
    const repoRoot = resolve(deps.harnessFeedbackRoot, '..', '..');
    const censusPath = resolve(repoRoot, 'docs', 'harness-feedback', 'registry', 'measurement-bundles.yaml');
    if (existsSync(censusPath)) {
      const cleanCensusSource = readMeasurementBundleCensusFile(repoRoot);
      assertMeasurementVerdictActionAllowed(parseYaml(cleanCensusSource), packet.domainId, packet.verdict);
    } else if (packet.verdict !== 'keep_observe') {
      throw new Error(
        `measurement_validity_gate: measurement bundle census missing; actionable verdict '${packet.verdict}' requires ${censusPath}`,
      );
    }

    const ref = await artifactPublisher.publishArtifact({
      packet,
      sourceRefs: input.sourceRefs,
      async generate(outputRoot) {
        generated = await generator(packet, input.sourceRefs, {
          harnessFeedbackRoot: outputRoot,
          liveHarnessFeedbackRoot: deps.harnessFeedbackRoot,
          ownerUserId: input.ownerUserId,
          taskOutcomeDbPath: deps.taskOutcomeDbPath,
          eventMemoryDbPath: deps.eventMemoryDbPath,
        });
        // Production generators materialize the bundle before returning. Keep
        // the lifecycle sidecar coupled to that real bundle, while allowing
        // publisher-level tests to use a path-only generator stub.
        if (existsSync(generated.bundleDir)) {
          writeLifecycleRootArtifact(generated.bundleDir, packet);
        }
        return generated;
      },
    });

    if (!generated) {
      return { status: 500, error: 'internal', detail: 'generate callback did not produce artifact' };
    }

    let attribution: unknown;
    try {
      const attrPath = resolve(ref.bundleDir, 'attribution.json');
      if (existsSync(attrPath)) attribution = JSON.parse(readFileSync(attrPath, 'utf8'));
    } catch {
      // Fail-open: undefined preserves the existing policy default.
    }
    computePublishPolicy(packet, attribution);

    return {
      ok: true,
      verdictPath: ref.verdictPath,
      bundleDir: ref.bundleDir,
      artifactId: ref.artifactId,
      artifactUrl: ref.artifactUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const mapped = mapPublishVerdictError(message);
    if (mapped) return mapped;
    if (!generated) return { status: 500, error: 'generator_failed', detail: message };
    return { status: 500, error: 'publisher_failed', detail: message };
  }
}
