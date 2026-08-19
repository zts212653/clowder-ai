import type { RecoveryCensusEntry } from './census.js';
import {
  type LegacyClosureAttachmentInventoryItem,
  type LegacyWithheldAttachment,
  normalizeLegacyAttachments,
} from './legacy-closure-migration.js';

const WITHHELD_LOG_MESSAGE = '[F254-E] draft withheld from normal thread final';

export interface LegacyWithheldLogEvent {
  withheldAtUtc: string;
  threadId: string;
  catId: string;
  invocationId: string;
  closureId: string;
  decisionKind: string;
  evidenceRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`legacy migration inventory ${field} is required`);
  return value.trim();
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`legacy migration inventory ${field} must be ISO`);
  return timestamp;
}

export function parseLegacyWithheldLogLine(
  line: string,
  sourcePath: string,
  lineNumber: number,
): LegacyWithheldLogEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.msg !== WITHHELD_LOG_MESSAGE) return null;
  if (!isRecord(value.decision)) throw new Error(`${sourcePath}:${lineNumber} withheld decision is missing`);
  return {
    withheldAtUtc: requireTimestamp(value.time, 'log.time'),
    threadId: requireString(value.threadId, 'log.threadId'),
    catId: requireString(value.catId, 'log.catId'),
    invocationId: requireString(value.invocationId, 'log.invocationId'),
    closureId: requireString(value.decision.closureId, 'log.decision.closureId'),
    decisionKind: requireString(value.decision.kind, 'log.decision.kind'),
    evidenceRef: `api-log:${sourcePath}#L${lineNumber}@${String(value.time)}`,
  };
}

function attachmentFromCensus(
  entry: RecoveryCensusEntry,
  closure: LegacyClosureAttachmentInventoryItem,
): LegacyWithheldAttachment {
  if (entry.threadId !== closure.threadId || entry.catId !== closure.catId || entry.userId !== closure.userId) {
    throw new Error(`census identity disagrees with active closure ${entry.closureId}`);
  }
  return {
    closureId: entry.closureId,
    invocationId: entry.invocationId,
    source: 'legacy_census',
    evidenceRefs: [`legacy-census:${entry.invocationId}@${entry.withheldAtUtc}`],
    withheldDecision: {
      withheldAtUtc: entry.withheldAtUtc,
      closureId: entry.closureId,
      decisionKind: entry.decisionKind,
    },
  };
}

function attachmentFromLog(
  event: LegacyWithheldLogEvent,
  closure: LegacyClosureAttachmentInventoryItem,
): LegacyWithheldAttachment {
  if (event.threadId !== closure.threadId || event.catId !== closure.catId) {
    throw new Error(`runtime log identity disagrees with active closure ${event.closureId}`);
  }
  return {
    closureId: event.closureId,
    invocationId: event.invocationId,
    source: 'runtime_log',
    evidenceRefs: [event.evidenceRef],
    withheldDecision: {
      withheldAtUtc: event.withheldAtUtc,
      closureId: event.closureId,
      decisionKind: event.decisionKind,
    },
  };
}

function attachmentFromClosureState(closure: LegacyClosureAttachmentInventoryItem): LegacyWithheldAttachment | null {
  const turnInvocationId = typeof closure.turnInvocationId === 'string' ? closure.turnInvocationId.trim() : '';
  const attempts = Array.isArray(closure.attempts) ? closure.attempts : [];
  const hasUnaccountedWithheldAttempt = attempts.some(
    (attempt) => attempt.outcome !== 'failed' && attempt.outcome !== 'canceled',
  );
  if (!turnInvocationId || hasUnaccountedWithheldAttempt) return null;
  return {
    closureId: closure.id,
    invocationId: turnInvocationId,
    source: 'closure_state',
    evidenceRefs: [
      `closure-state:cat-cafe:freshness:closure:detail:${closure.id}@revision=${closure.revision};turn=${turnInvocationId}`,
    ],
    withheldDecision: {
      // Rotated logs cannot supply the original decision timestamp/kind. The
      // durable closure-open time and frozen legacy classification are explicit
      // surrogates; the revisioned closure-state ref remains the custody proof.
      withheldAtUtc: new Date(closure.createdAt).toISOString(),
      closureId: closure.id,
      decisionKind: 'blocked_known_closure',
    },
  };
}

function collectClosureStateAttachments(
  closures: readonly LegacyClosureAttachmentInventoryItem[],
  attachedClosureIds: ReadonlySet<string>,
  legacyBefore: number,
): LegacyWithheldAttachment[] {
  const attachments: LegacyWithheldAttachment[] = [];
  for (const closure of closures) {
    if (attachedClosureIds.has(closure.id)) continue;
    if (!Number.isSafeInteger(closure.createdAt) || closure.createdAt >= legacyBefore) continue;
    const attachment = attachmentFromClosureState(closure);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

export function collectLegacyWithheldAttachments(input: {
  closures: readonly LegacyClosureAttachmentInventoryItem[];
  census: readonly RecoveryCensusEntry[];
  logEvents: readonly LegacyWithheldLogEvent[];
  legacyBeforeExclusive: string;
}): LegacyWithheldAttachment[] {
  const cutoff = Date.parse(input.legacyBeforeExclusive);
  if (!Number.isFinite(cutoff)) throw new Error('legacyBeforeExclusive must be ISO');
  const closures = new Map(input.closures.map((closure) => [closure.id, closure]));
  const attachments: LegacyWithheldAttachment[] = [];
  for (const entry of input.census) {
    const closure = closures.get(entry.closureId);
    if (closure) attachments.push(attachmentFromCensus(entry, closure));
  }
  for (const event of input.logEvents) {
    if (Date.parse(event.withheldAtUtc) >= cutoff) continue;
    const closure = closures.get(event.closureId);
    if (closure) attachments.push(attachmentFromLog(event, closure));
  }
  const attachedClosureIds = new Set(attachments.map((attachment) => attachment.closureId));
  // A superseded attempt proves the durable turn alone is not the closure's complete withheld-output inventory.
  attachments.push(...collectClosureStateAttachments(input.closures, attachedClosureIds, cutoff));
  return normalizeLegacyAttachments(attachments);
}
