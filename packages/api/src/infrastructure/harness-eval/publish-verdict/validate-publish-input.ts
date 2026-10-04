/**
 * F192 — Input validation for publish-verdict pipeline.
 *
 * Extracted from publish-verdict.ts to stay under 350-line hard cap.
 * All validation logic (packet schema, domain authorization, catId auth,
 * metric refs, packet ID format, sourceRefs kind) lives here. The handler
 * calls `validatePublishInput()` and either gets validated data or a HandlerError.
 *
 * R13: Split into three cohesive internal phases to keep per-function
 * cognitive complexity ≤ 15 (was 29 in the monolithic R9 original):
 *  - Phase 1: Packet schema + semantic validation (parse, consistency, temporal, handoff)
 *  - Phase 2: Domain resolution + catId authorization (lookup, Redis override, auth, metrics)
 *  - Phase 3: Packet ID format + source refs validation (slug, kind cross-check, per-kind)
 *
 * Validation ordering and 4xx contracts preserved from R9.
 *
 * @module
 */
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { loadDomains } from '../hub/eval-hub-read-model.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';
import {
  rejectServerOwnedFrictionPacketFields,
  validateFrictionAggregateWrite,
  validateFrictionAnalysisInput,
} from './friction-findings/friction-analysis-input.js';
import { validateMetricRefsAgainstGlossary } from './metric-glossary-validation.js';
import { validateSourceRefsForPublish } from './source-ref-handler-validation.js';
import type { HandlerError, PublishVerdictDeps, PublishVerdictInput, VerdictSourceRefs } from './types.js';
import { assertNoNewlineInBulletFields, inferSourceRefsKind, isKnownSourceRefsKind } from './validation.js';

// AC-H8: length + slug + idempotency (复用 generate-now 模式)
const MAX_VERDICT_ID_LEN = 128;
const MAX_PHENOMENON_LEN = 2048;
const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface ValidatedPublishInput {
  packet: VerdictHandoffPacket;
  analysisFindings?: Parameters<typeof validateFrictionAggregateWrite>[1];
  publicationTime: string;
}

// --- Phase 1: Packet schema + semantic validation ---

/**
 * Parse and validate packet schema, domain consistency, friction analysis,
 * temporal ordering, handoff completeness, and newline injection guards.
 */
function validatePacketAndSemantics(
  deps: PublishVerdictDeps,
  input: PublishVerdictInput,
): ValidatedPublishInput | HandlerError {
  const serverFieldError = rejectServerOwnedFrictionPacketFields(input.packet);
  if (serverFieldError) return serverFieldError;

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

  const analysisInput = validateFrictionAnalysisInput(packet.domainId, input.analysisFindings);
  if (analysisInput.error) return analysisInput.error;
  const analysisFindings = analysisInput.findings;
  const aggregateError = validateFrictionAggregateWrite(packet, analysisFindings);
  if (aggregateError) return aggregateError;

  // One server-owned clock governs both future-time rejection and generator
  // provenance. This must run before GitPublisher can create a branch, commit,
  // remote ref, or PR; packet.createdAt remains the event time and may be old,
  // but it cannot claim an event later than the publication request itself.
  const publicationTime = (deps.now?.() ?? new Date()).toISOString();
  if (Date.parse(packet.createdAt) > Date.parse(publicationTime)) {
    return {
      status: 400,
      error: 'packet_created_at_in_future',
      detail: `packet.createdAt '${packet.createdAt}' is later than server publication time '${publicationTime}'`,
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

  return { packet, analysisFindings, publicationTime };
}

// --- Phase 2: Domain resolution + catId authorization ---

/**
 * Look up the domain registry, resolve Redis override for eval cat, verify
 * catId authorization, and validate metric refs against the domain glossary.
 */
async function resolveDomainAndAuthorization(
  deps: PublishVerdictDeps,
  packet: VerdictHandoffPacket,
  catId: string | undefined,
): Promise<{ domainSourceRefsKind?: string } | HandlerError> {
  // AC-H3 + 砚砚 R6 P1: catId from callback auth (MCP layer). Domain allowlist
  // respects OQ-20 Redis override (symmetric with trigger-now), else static registry.
  if (!catId) {
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
  if (catId !== allowedCatId) {
    return {
      status: 403,
      error: 'not_allowed',
      detail: `catId '${catId}' is not the eval cat for domain '${packet.domainId}' (expected '${allowedCatId}'${overrideApplied ? ' via OQ-20 Redis override' : ' from registry'})`,
    };
  }

  const metricRefsError = validateMetricRefsAgainstGlossary(packet, domainEntry);
  if (metricRefsError) return metricRefsError;

  return { domainSourceRefsKind: domainEntry.sourceRefsKind };
}

// --- Phase 3: Packet ID format + source refs validation ---

/**
 * Validate packet ID format (length, slug pattern), phenomenon length,
 * cross-check sourceRefs kind against domain registry, and run per-kind
 * source refs validation.
 */
function validateFormatAndSourceRefs(
  packet: VerdictHandoffPacket,
  domainSourceRefsKind: string | undefined,
  sourceRefs: VerdictSourceRefs,
): HandlerError | null {
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
  // PR-2 (砚砚 R1 P1): handler pre-validates sourceRefs shape per kind for proper
  // 4xx error codes. Adapter-level validation is defense-in-depth (catches when
  // generator called outside handler flow), but user-facing validation lives here.
  //
  // cloud R8 P2 (PR-2): cross-check sourceRefs.kind ↔ packet.domainId BEFORE
  // per-kind validation. Wrong-shape input for a supported domain (e.g. a2a refs
  // sent for capability-wakeup domain, or cw selector sent for a2a domain) is
  // user-correctable; rejecting at 400 here is better UX than letting it
  // dispatch to adapter → throw `*_adapter_wrong_kind` → 500 generator_failed.
  const refsKind = inferSourceRefsKind(sourceRefs);
  if (domainSourceRefsKind && domainSourceRefsKind !== refsKind) {
    return {
      status: 400,
      error: 'sourceRefs_kind_mismatch',
      detail: `Domain '${packet.domainId}' expects sourceRefs.kind='${domainSourceRefsKind}', got '${refsKind}'. Registry sourceRefsKind is the contract; explicit validator/generator wiring must still exist for the domain to publish.`,
    };
  }
  if (!isKnownSourceRefsKind(refsKind)) {
    return {
      status: 501,
      error: 'unsupported_source_refs_kind',
      detail: `Domain '${packet.domainId}' declares sourceRefs.kind='${refsKind}', but publish-verdict has no validator wiring for that selector kind yet. Add explicit validator/generator wiring before using this kind.`,
    };
  }

  return validateSourceRefsForPublish(sourceRefs);
}

// --- Exported orchestrator ---

/**
 * Validate all input fields before the publish pipeline runs.
 * Returns validated data on success, or a HandlerError on failure.
 *
 * R13: Thin orchestrator — delegates to three cohesive validation phases.
 * Validation ordering and 4xx contracts preserved from R9 original.
 */
export async function validatePublishInput(
  deps: PublishVerdictDeps,
  input: PublishVerdictInput,
): Promise<ValidatedPublishInput | HandlerError> {
  // Phase 1: Packet schema + semantic integrity
  const semantics = validatePacketAndSemantics(deps, input);
  if ('status' in semantics) return semantics;

  // Phase 2: Domain resolution + catId authorization
  const auth = await resolveDomainAndAuthorization(deps, semantics.packet, input.catId);
  if ('status' in auth) return auth;

  // Phase 3: Packet ID format + source refs contract
  const formatError = validateFormatAndSourceRefs(semantics.packet, auth.domainSourceRefsKind, input.sourceRefs);
  if (formatError) return formatError;

  return semantics;
}
