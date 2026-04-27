/**
 * buildThreadMemory — F065 Phase B + F148 VG-3 + Phase G
 * Pure function: merges existing ThreadMemory with a new extractive digest,
 * producing an updated rolling summary. Rule-based (no LLM).
 *
 * Merge strategy:
 * 1. Format new digest as single session summary line
 * 2. Prepend to existing summary
 * 3. Trim oldest lines from end if over maxTokens
 * 4. Increment sessionsIncorporated
 * 5. VG-3: Merge DecisionSignals into structured decisions/openQuestions/artifacts
 * 6. G1: Artifact ledger — append+dedup+cap (cumulative, not overwrite)
 */

import { estimateTokens } from '../../../../utils/token-counter.js';
import type { ThreadMemoryV1 } from '../stores/ports/ThreadStore.js';
import type { DecisionSignals } from './extractDecisionSignals.js';
import type { ExtractiveDigestV1 } from './TranscriptWriter.js';

const MAX_FILES_PER_CATEGORY = 10;

/** Op priority: create > edit > delete > read */
const OP_PRIORITY: Record<string, number> = { create: 0, edit: 1, delete: 2, read: 3 };
const OP_LABELS: Record<string, string> = { create: 'Created', edit: 'Modified', delete: 'Deleted', read: 'Read' };
const OP_ORDER = ['create', 'edit', 'delete', 'read'];

function formatTimeShort(epoch: number): string {
  const d = new Date(epoch);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatSessionLine(digest: ExtractiveDigestV1, sessionNumber: number): string {
  const duration = Math.round((digest.time.sealedAt - digest.time.createdAt) / 60000);
  const timeRange = `${formatTimeShort(digest.time.createdAt)}-${formatTimeShort(digest.time.sealedAt)}`;

  // Group files by highest-priority op
  const groups = new Map<string, string[]>();
  for (const file of digest.filesTouched) {
    if (file.ops.length === 0) continue;
    const bestOp = file.ops.reduce((a, b) => ((OP_PRIORITY[a] ?? 99) <= (OP_PRIORITY[b] ?? 99) ? a : b));
    const list = groups.get(bestOp) ?? [];
    list.push(file.path);
    groups.set(bestOp, list);
  }

  // Format each group in priority order
  const parts: string[] = [];
  for (const op of OP_ORDER) {
    const files = groups.get(op);
    if (!files || files.length === 0) continue;
    const label = OP_LABELS[op] ?? op;
    const display = files.slice(0, MAX_FILES_PER_CATEGORY).join(', ');
    const extra = files.length > MAX_FILES_PER_CATEGORY ? ` +${files.length - MAX_FILES_PER_CATEGORY} more` : '';
    parts.push(`${label}: ${display}${extra}`);
  }

  // Errors
  const errorPart =
    digest.errors.length > 0 ? ` ${digest.errors.length} error${digest.errors.length > 1 ? 's' : ''}.` : '';

  const body = parts.length > 0 ? parts.join('. ') : 'No file ops';
  return `Session #${sessionNumber} (${timeRange}, ${duration}min): ${body}.${errorPart}`;
}

const MAX_DECISIONS = 8;
const MAX_OPEN_QUESTIONS = 5;
const MAX_ARTIFACTS = 8;
const MAX_LEDGER_ENTRIES = 20;

type LedgerEntry = NonNullable<ThreadMemoryV1['recentArtifacts']>[number];

function mergeArtifactLedger(
  existing: ThreadMemoryV1['recentArtifacts'],
  incoming: ThreadMemoryV1['recentArtifacts'],
): LedgerEntry[] | undefined {
  const existingArr = existing ?? [];
  const incomingArr = incoming ?? [];
  if (existingArr.length === 0 && incomingArr.length === 0) return undefined;

  const byRef = new Map<string, LedgerEntry>();
  for (const a of existingArr) byRef.set(a.ref, a);
  for (const a of incomingArr) {
    const prev = byRef.get(a.ref);
    if (!prev || a.updatedAt >= prev.updatedAt) byRef.set(a.ref, a);
  }

  return [...byRef.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LEDGER_ENTRIES);
}

/** Deduplicate strings by substring containment */
function dedupStrings(items: string[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    const dominated = result.some((e) => (e.length <= item.length ? item.includes(e) : e.includes(item)));
    if (!dominated) result.push(item);
  }
  return result;
}

export function buildThreadMemory(
  existing: ThreadMemoryV1 | null,
  newDigest: ExtractiveDigestV1,
  maxTokens: number,
  signals?: DecisionSignals,
  recentArtifacts?: ThreadMemoryV1['recentArtifacts'],
): ThreadMemoryV1 {
  // R1 P1-1: session number comes from digest.seq (1-based display), not merge count
  const sessionNumber = newDigest.seq + 1;
  const mergeCount = (existing?.sessionsIncorporated ?? 0) + 1;
  const newLine = formatSessionLine(newDigest, sessionNumber);

  // Prepend new session line to existing summary
  const existingLines = existing?.summary ? existing.summary.split('\n') : [];
  const allLines = [newLine, ...existingLines];

  // Trim oldest lines (from end) until within token budget
  let summary = allLines.join('\n');
  while (estimateTokens(summary) > maxTokens && allLines.length > 1) {
    allLines.pop();
    summary = allLines.join('\n');
  }

  // R1 P2-1 hard-cap: if single remaining line still exceeds maxTokens,
  // truncate it (rough char-level cut, re-estimate)
  if (estimateTokens(summary) > maxTokens) {
    const ratio = maxTokens / Math.max(1, estimateTokens(summary));
    summary = `${summary.slice(0, Math.floor(summary.length * ratio * 0.9))}...`;
  }

  // VG-3: Merge structured decision signals
  const result: ThreadMemoryV1 = {
    v: 1,
    summary,
    sessionsIncorporated: mergeCount,
    updatedAt: Date.now(),
  };

  if (signals) {
    const existDecisions = existing?.decisions ?? [];
    const existQuestions = existing?.openQuestions ?? [];
    const existArtifacts = existing?.artifacts ?? [];

    const mergedDecisions = dedupStrings([...signals.decisions, ...existDecisions]);
    const mergedQuestions = dedupStrings([...signals.openQuestions, ...existQuestions]);
    const mergedArtifacts = dedupStrings([...signals.artifacts, ...existArtifacts]);

    if (mergedDecisions.length > 0) result.decisions = mergedDecisions.slice(0, MAX_DECISIONS);
    if (mergedQuestions.length > 0) result.openQuestions = mergedQuestions.slice(0, MAX_OPEN_QUESTIONS);
    if (mergedArtifacts.length > 0) result.artifacts = mergedArtifacts.slice(0, MAX_ARTIFACTS);
  } else if (existing) {
    // P1-2 fix: carry forward existing decisions when signals extraction failed
    // Cloud-P2 fix: re-apply caps; Cloud-R2-P1 fix: Array.isArray guard for malformed data
    if (Array.isArray(existing.decisions) && existing.decisions.length > 0)
      result.decisions = existing.decisions.slice(0, MAX_DECISIONS);
    if (Array.isArray(existing.openQuestions) && existing.openQuestions.length > 0)
      result.openQuestions = existing.openQuestions.slice(0, MAX_OPEN_QUESTIONS);
    if (Array.isArray(existing.artifacts) && existing.artifacts.length > 0)
      result.artifacts = existing.artifacts.slice(0, MAX_ARTIFACTS);
  }

  const ledger = mergeArtifactLedger(existing?.recentArtifacts, recentArtifacts);
  if (ledger) result.recentArtifacts = ledger;

  return result;
}
