/**
 * F192 E-community AC-E14: Sanitized Issue Packet schema + export function.
 *
 * Enables community instances to export eval findings as deidentified
 * issue packets — strips internal thread IDs, cat identities, feature IDs,
 * and evidence ref strings while preserving the analytical signal (phenomenon,
 * trend, hypothesis, verdict, counterarguments).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

// ---- Schema ----

const sanitizedIssuePacketSchema = z.object({
  /** Opaque packet ID (may be derived from internal verdict ID). */
  id: z.string().min(1),

  /** Domain identifier — must match eval:<lowercase-slug> (not restricted to internal enum). */
  domainId: z.string().regex(/^eval:[a-z][a-z0-9_-]*$/, 'domainId must match eval:<lowercase-slug>'),

  /** ISO 8601 timestamp when the packet was exported. */
  exportedAt: z.string().datetime({ offset: true }),

  /** Identifies the Clowder AI instance that produced this packet. */
  sourceInstanceId: z.string().min(1),

  /** What happened — the core eval observation. */
  phenomenon: z.string().min(1),

  /** Harness component being evaluated (generic names, no internal feature IDs). */
  harnessComponent: z.object({
    componentId: z.string().min(1),
    name: z.string().min(1),
  }),

  /** Evidence counts (original refs redacted). */
  evidenceSummary: z.object({
    snapshotCount: z.number().int().nonnegative(),
    attributionCount: z.number().int().nonnegative(),
    metricCount: z.number().int().nonnegative(),
    traceCount: z.number().int().nonnegative(),
  }),

  /** Day-over-day trend (numeric, no PII). */
  dailyTrend: z.object({
    window: z.string().min(1),
    current: z.record(z.number()),
    baseline: z.record(z.number()),
    threshold: z.record(z.number()),
    direction: z.enum(['improved', 'regressed', 'flat', 'unknown']),
  }),

  /** Root cause hypothesis (analytical text). */
  rootCauseHypothesis: z.object({
    summary: z.string().min(1),
    confidence: z.enum(['low', 'medium', 'high']),
    alternatives: z.array(z.string().min(1)).min(1),
  }),

  /** Verdict: delete_sunset / build / fix / keep_observe. */
  verdict: z.enum(['delete_sunset', 'build', 'fix', 'keep_observe']),

  /** What the exporting instance recommends the community do. */
  requestedAction: z.string().min(1),

  /** Devil's advocate — why the verdict might be wrong. */
  counterarguments: z.array(z.string().min(1)).min(1),
});

export type SanitizedIssuePacket = z.infer<typeof sanitizedIssuePacketSchema>;

// ---- Parse ----

export function parseSanitizedIssuePacket(input: unknown): SanitizedIssuePacket {
  return sanitizedIssuePacketSchema.parse(input);
}

// ---- Internal pattern scrubbing ----

/**
 * Known internal identifier patterns to scrub from free-text fields.
 * Each tuple: [regex, replacement placeholder].
 *
 * ORDER MATTERS: Evidence refs must match before feature IDs, because
 * refs like `snapshot:eval-F167-2026-05-21` contain embedded F\d{3}.
 * If feature IDs fire first, the ref fragments into `snapshot:eval-[feature]-2026-05-21`
 * and the evidence ref regex can no longer match the whole string.
 */
const SCRUB_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // 1. Evidence refs FIRST — longest/most specific (both hyphen and colon separators)
  //    `attr(?:ibution)?` matches both `attr:` and `attribution:` prefixes.
  //    `/` in character class handles slash-delimited hierarchical refs like
  //    `snapshot:sop-eval/def-123/sess-456`.
  [/\b(?:snapshot|trace|attr(?:ibution)?|metric)[:-][a-z0-9_./-]+\b/gi, '[ref]'],
  // 2. Feature IDs: F followed by 3 digits (e.g. F167, F192, F167_ball_drop_rate)
  //    (?:\b|(?=_)) allows matching before underscore in compound metric names
  [/\bF\d{3}(?:\b|(?=_))/g, '[feature]'],
  // 3. Thread IDs: thread_ prefixed identifiers
  [/\bthread_[a-z0-9_]+\b/gi, '[thread]'],
  // 4. Known Clowder AI agent identifiers (compile-time baseline)
  //    (?:\b|(?=_)) allows matching before underscore in compound metric names
  [
    /\b(?:opus|opus45|opus47|sonnet|codex|gpt52|gemini|gemini25|spark|antigravity|antig-opus|opencode|mini|glm|kimi|qwen|deepseek)(?:\b|(?=_))/gi,
    '[agent]',
  ],
];

/** Escape special regex characters in a literal string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrub known internal patterns from a free-text string.
 * @param extraTerms Additional literal strings to scrub (e.g., specific catId
 *   extracted from the packet). Each non-empty term is word-boundary matched.
 */
function scrubInternalPatterns(text: string, extraTerms: readonly string[] = []): string {
  let result = text;
  for (const [pattern, replacement] of SCRUB_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  for (const term of extraTerms) {
    if (term.length > 0) {
      result = result.replace(new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'), '[agent]');
    }
  }
  return result;
}

/**
 * Build a stable original→scrubbed key mapping from the union of all keys
 * across multiple records. When multiple keys scrub to the same placeholder
 * (e.g. F167_latency and F192_latency → [feature]_latency), disambiguate
 * with a numeric suffix. The mapping is then applied consistently to all
 * records so cross-record comparison (current vs baseline vs threshold)
 * always refers to the same original metric.
 */
function buildScrubKeyMap(
  records: ReadonlyArray<Record<string, number>>,
  scrub: (text: string) => string,
): Map<string, string> {
  const allKeys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      allKeys.add(key);
    }
  }

  const keyMap = new Map<string, string>();
  const usedScrubbed = new Set<string>();
  for (const key of allKeys) {
    let scrubbed = scrub(key);
    if (usedScrubbed.has(scrubbed)) {
      let suffix = 2;
      while (usedScrubbed.has(`${scrubbed}_${suffix}`)) {
        suffix++;
      }
      scrubbed = `${scrubbed}_${suffix}`;
    }
    usedScrubbed.add(scrubbed);
    keyMap.set(key, scrubbed);
  }
  return keyMap;
}

/** Apply a pre-built key mapping to a single record. */
function applyKeyMap(record: Record<string, number>, keyMap: Map<string, string>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    result[keyMap.get(key) ?? key] = value;
  }
  return result;
}

// ---- Sanitize export ----

/**
 * Transforms an internal VerdictHandoffPacket into a SanitizedIssuePacket
 * by stripping internal references (feature IDs, cat IDs, evidence ref
 * strings) and replacing them with opaque/redacted equivalents.
 *
 * Free-text fields (phenomenon, hypothesis, requestedAction, counterarguments)
 * and structural fields (harnessComponent) are scrubbed for known internal
 * patterns (F\d{3}, thread_*, evidence refs) plus the packet's own catId.
 */
export function sanitizeVerdictForExport(packet: VerdictHandoffPacket, sourceInstanceId: string): SanitizedIssuePacket {
  // Dynamic terms: scrub the specific catId from this verdict's ownerAsk
  const extraTerms = [packet.ownerAsk.targetOwnerCatId].filter(Boolean);
  const scrub = (text: string) => scrubInternalPatterns(text, extraTerms);

  return {
    id: `sip-${randomUUID()}`,
    domainId: packet.domainId,
    exportedAt: new Date().toISOString(),
    sourceInstanceId,
    phenomenon: scrub(packet.phenomenon),
    harnessComponent: {
      componentId: scrub(packet.harnessUnderEval.componentId),
      name: scrub(packet.harnessUnderEval.name),
    },
    evidenceSummary: {
      snapshotCount: packet.evidencePacket.snapshotRefs.length,
      attributionCount: packet.evidencePacket.attributionRefs.length,
      metricCount: packet.evidencePacket.metricRefs.length,
      traceCount: packet.evidencePacket.sampleTraceRefs.length,
    },
    dailyTrend: (() => {
      const trendRecords = [packet.dailyTrend.current, packet.dailyTrend.baseline, packet.dailyTrend.threshold];
      const keyMap = buildScrubKeyMap(trendRecords, scrub);
      return {
        window: scrub(packet.dailyTrend.window),
        current: applyKeyMap(packet.dailyTrend.current, keyMap),
        baseline: applyKeyMap(packet.dailyTrend.baseline, keyMap),
        threshold: applyKeyMap(packet.dailyTrend.threshold, keyMap),
        direction: packet.dailyTrend.direction,
      };
    })(),
    rootCauseHypothesis: {
      summary: scrub(packet.rootCauseHypothesis.summary),
      confidence: packet.rootCauseHypothesis.confidence,
      alternatives: packet.rootCauseHypothesis.alternatives.map(scrub),
    },
    verdict: packet.verdict,
    requestedAction: scrub(packet.ownerAsk.requestedAction),
    counterarguments: packet.counterarguments.map(scrub),
  };
}
