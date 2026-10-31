/**
 * F192 E-sop AC-E21: eval:sop verdict adapter.
 *
 * Transforms SopEvalResult[] from the predicate evaluator into a
 * VerdictHandoffPacket for cross-thread handoff to the SOP rule owner.
 *
 * Verdicts:
 * - violations exist → 'fix' (SOP compliance failures are correctable)
 * - no violations → 'keep_observe'
 */

import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from '../verdict-handoff.js';
import type { RuleOwner, SopDefinitionInput, SopEvalResult } from './sop-predicate-evaluator.js';
import { evaluateSopDefinition } from './sop-predicate-evaluator.js';
import type { SopTrace } from './sop-trace-adapter.js';

/**
 * AC-E21: Optional rule-owner → handoff target resolver.
 * Maps a RuleOwner (from SOP definition) to a concrete featureId + ownerCatId
 * for verdict handoff routing. When not provided or returns undefined,
 * falls back to domain-level handoffTargetResolver.
 */
export type RuleHandoffTargetResolver = (owner: RuleOwner) => { featureId: string; ownerCatId: string } | undefined;

/**
 * AC-E21: Session context for default rule-owner resolution.
 * When violations have rule owners AND sessionContext is provided,
 * the default resolver routes the verdict to the session author
 * (the cat who committed the SOP violation) rather than the domain
 * infrastructure maintainer. This is the "按 rule 归属解析" path
 * that triggers based on rule ownership existence.
 */
export interface SopSessionContext {
  /** The catId of the session author whose trace is being evaluated. */
  readonly authorCatId: string;
  /** The featureId the session was working on (if known). */
  readonly featureId?: string;
}

export interface BuildSopVerdictInput {
  readonly domain: EvalDomainRegistryEntry;
  readonly sopDefinitionId: string;
  readonly sessionId: string;
  readonly evalResults: readonly SopEvalResult[];
  /** AC-E21: custom resolver — takes precedence over sessionContext. */
  readonly resolveRuleHandoffTarget?: RuleHandoffTargetResolver;
  /** AC-E21: session context — enables default per-rule-owner routing. */
  readonly sessionContext?: SopSessionContext;
}

export interface SopReevalInput extends BuildSopVerdictInput {
  readonly previousVerdict: VerdictHandoffPacket;
}

export interface SopReevalResult {
  readonly closureMet: boolean;
  readonly resolvedRuleIds: readonly string[];
  readonly persistingRuleIds: readonly string[];
  readonly newViolationRuleIds: readonly string[];
  readonly verdict: VerdictHandoffPacket;
}

export function buildSopVerdictHandoff(input: BuildSopVerdictInput): VerdictHandoffPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);

  if (domain.domainId !== 'eval:sop') {
    throw new Error(`SOP verdict adapter requires eval:sop domain, got ${domain.domainId}`);
  }

  if (input.evalResults.length === 0) {
    throw new Error('Cannot build SOP verdict: evalResults is empty — run evaluateSopDefinition first');
  }

  const now = new Date().toISOString();
  const violations = input.evalResults.filter((r) => r.status === 'violation' && r.violation);
  const packetInput =
    violations.length > 0
      ? buildViolationPacketInput(domain, input, violations, now)
      : buildKeepObservePacketInput(domain, input, now);

  const packet = parseVerdictHandoffPacket(packetInput);
  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    throw new Error(handoffDecision.reason ?? 'verdict handoff packet is incomplete');
  }
  return packet;
}

/**
 * Re-eval closure check (AC-E24).
 *
 * Compares new evalResults against a previousVerdict's violated rules.
 * If all previously-violated rules now pass AND no new violations →
 * closure is met (keep_observe). Otherwise → new fix verdict.
 */
export function reevalSopVerdict(input: SopReevalInput): SopReevalResult {
  const { previousVerdict, evalResults } = input;

  // Extract rule IDs from the previous verdict's closure condition
  const previousViolationRuleIds = extractRuleIdsFromClosureCondition(previousVerdict);

  // Current violations
  const currentViolations = evalResults.filter((r) => r.status === 'violation' && r.violation);
  const currentViolationRuleIds = new Set(currentViolations.map((v) => v.violation!.ruleId));

  // Classify
  const resolvedRuleIds = previousViolationRuleIds.filter((id) => !currentViolationRuleIds.has(id));
  const persistingRuleIds = previousViolationRuleIds.filter((id) => currentViolationRuleIds.has(id));
  const newViolationRuleIds = currentViolations
    .filter((v) => !previousViolationRuleIds.includes(v.violation!.ruleId))
    .map((v) => v.violation!.ruleId);

  const closureMet = persistingRuleIds.length === 0 && newViolationRuleIds.length === 0;

  // Build the new verdict (forward resolver + session context for AC-E21 rule-owner routing)
  const verdict = buildSopVerdictHandoff({
    domain: input.domain,
    sopDefinitionId: input.sopDefinitionId,
    sessionId: input.sessionId,
    evalResults: input.evalResults,
    resolveRuleHandoffTarget: input.resolveRuleHandoffTarget,
    sessionContext: input.sessionContext,
  });

  return {
    closureMet,
    resolvedRuleIds,
    persistingRuleIds,
    newViolationRuleIds,
    verdict,
  };
}

// ---- Production orchestrator (AC-E21 wiring) ----

export interface RunSopEvalInput {
  readonly domain: EvalDomainRegistryEntry;
  readonly sopDefinition: SopDefinitionInput;
  readonly trace: SopTrace;
  /** Optional custom resolver — tier 1. Most callers omit this. */
  readonly resolveRuleHandoffTarget?: RuleHandoffTargetResolver;
}

/**
 * AC-E21: Production-path orchestrator for SOP eval.
 *
 * Ties together trace → evaluateSopDefinition → buildSopVerdictHandoff
 * and **derives sessionContext from the trace** so that rule-owner
 * handoff routing works out of the box without external injection.
 *
 * The trace's `handles.author` IS the session author — the cat whose
 * SOP compliance is being evaluated. When violations have rule owners,
 * the verdict routes to this author (tier 2) rather than the domain
 * infra maintainer (tier 3).
 */
export function runSopEval(input: RunSopEvalInput): VerdictHandoffPacket {
  const evalResults = evaluateSopDefinition(input.sopDefinition, input.trace);

  // Derive sessionContext from the trace — this is the production wiring
  // that makes AC-E21 "按 rule 归属解析" work without external injection.
  const sessionContext: SopSessionContext | undefined = input.trace.handles.author
    ? { authorCatId: input.trace.handles.author }
    : undefined;

  return buildSopVerdictHandoff({
    domain: input.domain,
    sopDefinitionId: input.trace.sopDefinitionId,
    sessionId: input.trace.sessionId,
    evalResults,
    resolveRuleHandoffTarget: input.resolveRuleHandoffTarget,
    sessionContext,
  });
}

/**
 * Extract rule IDs from a verdict's closureCondition string.
 * Format: "next eval of {sopDefId} reports 0 violations for rules: ruleA, ruleB"
 * If the verdict was keep_observe, the closure condition won't mention rules.
 */
function extractRuleIdsFromClosureCondition(verdict: VerdictHandoffPacket): string[] {
  const condition = verdict.acceptanceReevalPlan.closureCondition;
  const match = condition.match(/rules:\s*(.+)$/);
  if (!match) return []; // keep_observe verdict — no specific rules
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- Violation packet ----

function buildViolationPacketInput(
  domain: EvalDomainRegistryEntry,
  input: BuildSopVerdictInput,
  violations: readonly SopEvalResult[],
  createdAt: string,
): unknown {
  const worstSeverity = resolveWorstSeverity(violations);
  const violationSummaries = violations.map((v) => `${v.violation!.ruleId} (${v.violation!.severity})`);
  const traceAnchors = violations.map((v) => v.violation!.traceAnchor);
  const ruleIds = violations.map((v) => v.violation!.ruleId);
  const counts = countsByStatus(input.evalResults);

  // AC-E21: resolve handoff target per rule owner (session context → custom resolver → domain fallback)
  const { targetFeatureId, targetOwnerCatId } = resolveOwnerAskTarget(
    domain,
    violations,
    input.resolveRuleHandoffTarget,
    input.sessionContext,
  );

  return {
    id: packetId(input.sopDefinitionId, input.sessionId, createdAt),
    domainId: domain.domainId,
    createdAt,
    phenomenon: `SOP ${input.sopDefinitionId}: ${violations.length} violation(s) [${worstSeverity}]: ${violationSummaries.join(', ')}`,
    harnessUnderEval: {
      featureId: domain.handoffTargetResolver.featureId,
      componentId: input.sopDefinitionId,
      name: `SOP ${input.sopDefinitionId} compliance`,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:sop-eval/${input.sopDefinitionId}/${input.sessionId}`],
      attributionRefs: ruleIds.map((id) => `attribution:sop-rule/${id}`),
      metricRefs: sopMetricRefs(),
      sampleTraceRefs: traceAnchors,
    },
    dailyTrend: {
      window: `${domain.sla.reevalWithinHours}h`,
      current: counts,
      baseline: {},
      threshold: {},
      direction: 'regressed',
    },
    rootCauseHypothesis: {
      summary: violations
        .map((v) => {
          const ownerTag = v.violation!.owner ? ` [${v.violation!.owner.skill}]` : '';
          return `${v.violation!.stageId}/${v.violation!.ruleId}${ownerTag}: ${v.violation!.message}`;
        })
        .join('; '),
      confidence: worstSeverity === 'blocker' ? 'high' : 'medium',
      alternatives: violations.map((v) => `${v.violation!.predicateType}: ${v.violation!.message}`),
    },
    verdict: 'fix',
    ownerAsk: {
      targetFeatureId,
      targetOwnerCatId,
      requestedAction: buildOwnerAwareRequestedAction(violations),
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(createdAt, domain),
      closureCondition: `next eval of ${input.sopDefinitionId} reports 0 violations for rules: ${ruleIds.join(', ')}`,
    },
    counterarguments: [
      'Predicate may fire on edge-case command patterns not representative of typical sessions.',
      ...(violations.some((v) => v.violation!.kind === 'pitfall')
        ? ['Pitfall violations are warnings, not hard blockers — consider if the SOP definition is overly strict.']
        : []),
    ],
  };
}

// ---- Keep-observe packet ----

function buildKeepObservePacketInput(
  domain: EvalDomainRegistryEntry,
  input: BuildSopVerdictInput,
  createdAt: string,
): unknown {
  const counts = countsByStatus(input.evalResults);

  return {
    id: packetId(input.sopDefinitionId, input.sessionId, createdAt),
    domainId: domain.domainId,
    createdAt,
    phenomenon: `No SOP violations for ${input.sopDefinitionId} — ${counts.rules_passed} passed, ${counts.rules_skipped} skipped`,
    harnessUnderEval: {
      featureId: domain.handoffTargetResolver.featureId,
      componentId: input.sopDefinitionId,
      name: `SOP ${input.sopDefinitionId} compliance`,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:sop-eval/${input.sopDefinitionId}/${input.sessionId}`],
      attributionRefs: ['attribution:sop-eval/no-violation'],
      metricRefs: sopMetricRefs(),
      sampleTraceRefs: [`session:${input.sessionId}`],
    },
    dailyTrend: {
      window: `${domain.sla.reevalWithinHours}h`,
      current: counts,
      baseline: {},
      threshold: {},
      direction: 'flat',
    },
    rootCauseHypothesis: {
      summary: 'All machine-checkable SOP predicates passed or were skipped (manual_only).',
      confidence: 'medium',
      alternatives: ['Clean result may reflect low coverage — manual_only rules are not evaluated.'],
    },
    verdict: 'keep_observe',
    ownerAsk: {
      targetFeatureId: domain.handoffTargetResolver.featureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction: 'No action required; keep observing the next scheduled eval.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: nextEvalAt(createdAt, domain),
      closureCondition: 'next eval remains clean',
    },
    counterarguments: ['A clean eval window may hide infrequent violations; keep the scheduled eval active.'],
  };
}

// ---- Helpers ----

/**
 * AC-E21: Resolve ownerAsk target from rule violations.
 *
 * Three-tier resolution (first match wins):
 * 1. Explicit resolver callback → resolver(primaryOwner)
 * 2. Session context → route to session author (the cat whose session
 *    violated the SOP), gated by rule ownership existence
 * 3. Domain-level fallback → handoffTargetResolver
 *
 * Tier 2 is the "按 rule 归属解析" default path: it fires because
 * the violated rule HAS an owner, and routes to the session author
 * who should fix their SOP violation. The rule's skill attribution
 * is in requestedAction (what to fix), the session author is in
 * targetOwnerCatId (who should fix it).
 */
function resolveOwnerAskTarget(
  domain: EvalDomainRegistryEntry,
  violations: readonly SopEvalResult[],
  resolver?: RuleHandoffTargetResolver,
  sessionContext?: SopSessionContext,
): { targetFeatureId: string; targetOwnerCatId: string } {
  const domainFallback = {
    targetFeatureId: domain.handoffTargetResolver.featureId,
    targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
  };

  const primaryOwner = findPrimaryViolationOwner(violations);

  // Tier 1: explicit resolver
  if (resolver && primaryOwner) {
    const resolved = resolver(primaryOwner);
    if (resolved) {
      return { targetFeatureId: resolved.featureId, targetOwnerCatId: resolved.ownerCatId };
    }
  }

  // Tier 2: session context — route to session author when violations have rule owners
  if (sessionContext && primaryOwner) {
    return {
      targetFeatureId: sessionContext.featureId ?? domainFallback.targetFeatureId,
      targetOwnerCatId: sessionContext.authorCatId,
    };
  }

  // Tier 3: domain-level fallback
  return domainFallback;
}

/**
 * Find the owner of the worst-severity violation.
 * Severity order: blocker > warn > info. Ties broken by array position.
 */
function findPrimaryViolationOwner(violations: readonly SopEvalResult[]): RuleOwner | undefined {
  const severityRank: Record<string, number> = { blocker: 0, warn: 1, info: 2 };

  let primary: RuleOwner | undefined;
  let primaryRank = Infinity;

  for (const v of violations) {
    if (!v.violation?.owner) continue;
    const rank = severityRank[v.violation.severity] ?? 3;
    if (rank < primaryRank) {
      primaryRank = rank;
      primary = v.violation.owner;
    }
  }

  return primary;
}

function resolveWorstSeverity(violations: readonly SopEvalResult[]): string {
  const severities = violations.map((v) => v.violation!.severity);
  if (severities.includes('blocker')) return 'blocker';
  if (severities.includes('warn')) return 'warn';
  return 'info';
}

interface SopEvalCounts {
  violations_blocker: number;
  violations_warn: number;
  violations_info: number;
  rules_passed: number;
  rules_skipped: number;
}

function countsByStatus(results: readonly SopEvalResult[]): SopEvalCounts {
  const counts: SopEvalCounts = {
    violations_blocker: 0,
    violations_warn: 0,
    violations_info: 0,
    rules_passed: 0,
    rules_skipped: 0,
  };
  for (const r of results) {
    if (r.status === 'pass') counts.rules_passed++;
    else if (r.status === 'skipped') counts.rules_skipped++;
    else if (r.status === 'violation' && r.violation) {
      switch (r.violation.severity) {
        case 'blocker':
          counts.violations_blocker++;
          break;
        case 'warn':
          counts.violations_warn++;
          break;
        case 'info':
          counts.violations_info++;
          break;
      }
    }
  }
  return counts;
}

function sopMetricRefs(): string[] {
  return ['sop_violations_blocker', 'sop_violations_warn', 'sop_rules_passed', 'sop_rules_skipped'];
}

function packetId(sopDefId: string, sessionId: string, createdAt: string): string {
  const slugDate = createdAt.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `vhp_eval_sop_${sopDefId}_${slugDate}_${sessionId.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

function nextEvalAt(createdAt: string, domain: EvalDomainRegistryEntry): string {
  return new Date(Date.parse(createdAt) + domain.sla.reevalWithinHours * 3_600_000).toISOString();
}

/**
 * AC-E21: Build per-rule owner-aware action string.
 * Groups violations by owner skill so the handoff target knows
 * which SOP skill owns each violated rule.
 */
function buildOwnerAwareRequestedAction(violations: readonly SopEvalResult[]): string {
  const bySkill = new Map<string, string[]>();
  for (const v of violations) {
    const skill = v.violation?.owner?.skill ?? 'unknown';
    const arr = bySkill.get(skill) ?? [];
    arr.push(v.ruleId);
    bySkill.set(skill, arr);
  }

  const parts: string[] = [];
  for (const [skill, ruleIds] of bySkill) {
    parts.push(`${skill}: ${ruleIds.join(', ')}`);
  }

  return `Fix SOP violations by owner — ${parts.join('; ')}. Review trace evidence and update either the session behavior or the SOP definition.`;
}
