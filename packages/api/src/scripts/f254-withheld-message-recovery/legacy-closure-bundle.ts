import {
  type LegacyClosureInventoryItem,
  type LegacyWithheldAttachment,
  normalizeLegacyAttachments,
} from './legacy-closure-migration.js';
import { sha256Text, type ValidatedRecoveryManifest, validateRecoveryManifest } from './manifest.js';

const PRODUCTION_CONFIRMATION = 'MIGRATE F254 LEGACY CLOSURES TO 6399';

export { collectLegacyWithheldAttachments, parseLegacyWithheldLogLine } from './legacy-closure-inventory.js';

export interface LegacyClosureMigrationBundle {
  version: 1;
  incident: 'F254-legacy-closure-migration';
  generatedAt: string;
  legacyBeforeExclusive: string;
  cvoDecisionRef: string;
  closures: LegacyClosureInventoryItem[];
  attachments: LegacyWithheldAttachment[];
  recoveryManifest: ValidatedRecoveryManifest;
  bundleSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`legacy migration bundle ${field} is required`);
  return value.trim();
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`legacy migration bundle ${field} must be ISO`);
  return timestamp;
}

function parseClosure(value: unknown, legacyBefore: number): LegacyClosureInventoryItem {
  if (!isRecord(value)) throw new Error('legacy migration bundle closure must be an object');
  const closure: LegacyClosureInventoryItem = {
    id: requireString(value.id, 'closure.id'),
    userId: requireString(value.userId, 'closure.userId'),
    threadId: requireString(value.threadId, 'closure.threadId'),
    catId: requireString(value.catId, 'closure.catId'),
    status: value.status as LegacyClosureInventoryItem['status'],
    revision: value.revision as number,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
  if (closure.status !== 'blocked') throw new Error(`legacy closure ${closure.id} must be inactive and blocked`);
  if (!Number.isSafeInteger(closure.revision) || closure.revision < 0) {
    throw new Error(`legacy closure ${closure.id} revision is invalid`);
  }
  if (!Number.isSafeInteger(closure.createdAt) || !Number.isSafeInteger(closure.updatedAt)) {
    throw new Error(`legacy closure ${closure.id} timestamps are invalid`);
  }
  if (closure.createdAt >= legacyBefore) {
    throw new Error(`legacy closure ${closure.id} was created after the migration cutoff`);
  }
  return closure;
}

function parseAttachment(value: unknown): LegacyWithheldAttachment {
  if (!isRecord(value)) throw new Error('legacy migration bundle attachment must be an object');
  const source = value.source;
  if (source !== 'legacy_census' && source !== 'runtime_log' && source !== 'closure_state') {
    throw new Error('legacy migration bundle attachment source is invalid');
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((item) => typeof item !== 'string')) {
    throw new Error('legacy migration bundle attachment evidenceRefs are invalid');
  }
  let withheldDecision: LegacyWithheldAttachment['withheldDecision'];
  if (value.withheldDecision !== undefined) {
    if (!isRecord(value.withheldDecision)) throw new Error('legacy migration bundle withheldDecision is invalid');
    withheldDecision = {
      withheldAtUtc: requireTimestamp(value.withheldDecision.withheldAtUtc, 'withheldDecision.withheldAtUtc'),
      closureId: requireString(value.withheldDecision.closureId, 'withheldDecision.closureId'),
      decisionKind: requireString(value.withheldDecision.decisionKind, 'withheldDecision.decisionKind'),
    };
  }
  return {
    closureId: requireString(value.closureId, 'attachment.closureId'),
    invocationId: requireString(value.invocationId, 'attachment.invocationId'),
    source,
    evidenceRefs: value.evidenceRefs as string[],
    ...(withheldDecision ? { withheldDecision } : {}),
  };
}

function parseBundleClosures(raw: unknown, legacyBefore: number): LegacyClosureInventoryItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('legacy migration bundle closures must be non-empty');
  }
  const closures = raw.map((closure) => parseClosure(closure, legacyBefore)).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(closures.map((closure) => closure.id)).size !== closures.length) {
    throw new Error('legacy migration bundle closure inventory contains duplicates');
  }
  return closures;
}

function assertAttachmentEvidenceCoverage(
  closures: readonly LegacyClosureInventoryItem[],
  attachments: readonly LegacyWithheldAttachment[],
  recoveryManifest: ValidatedRecoveryManifest,
): void {
  const closureMap = new Map(closures.map((closure) => [closure.id, closure]));
  const entryMap = new Map(recoveryManifest.entries.map((entry) => [entry.invocationId, entry]));
  const omissionIds = new Set((recoveryManifest.omissions ?? []).map((item) => item.invocationId));
  const attachedClosureIds = new Set<string>();
  for (const attachment of attachments) {
    const closure = closureMap.get(attachment.closureId);
    if (!closure) throw new Error(`attachment references closure outside frozen inventory: ${attachment.closureId}`);
    attachedClosureIds.add(closure.id);
    const entry = entryMap.get(attachment.invocationId);
    if (!entry && !omissionIds.has(attachment.invocationId)) {
      throw new Error(`attachment ${attachment.invocationId} is not accounted by recovery evidence`);
    }
    if (
      entry &&
      (entry.threadId !== closure.threadId || entry.userId !== closure.userId || entry.catId !== closure.catId)
    ) {
      throw new Error(`recovery entry identity disagrees with closure ${closure.id}`);
    }
  }
  const missing = closures.filter((closure) => !attachedClosureIds.has(closure.id)).map((closure) => closure.id);
  if (missing.length > 0) throw new Error(`active closures lack withheld invocation inventory: ${missing.join(', ')}`);
}

function normalizeBundle(raw: unknown): Omit<LegacyClosureMigrationBundle, 'bundleSha256'> {
  if (!isRecord(raw) || raw.version !== 1 || raw.incident !== 'F254-legacy-closure-migration') {
    throw new Error('legacy migration bundle must use version=1 and the F254 incident identity');
  }
  const generatedAt = requireTimestamp(raw.generatedAt, 'generatedAt');
  const legacyBeforeExclusive = requireTimestamp(raw.legacyBeforeExclusive, 'legacyBeforeExclusive');
  const legacyBefore = Date.parse(legacyBeforeExclusive);
  const cvoDecisionRef = requireString(raw.cvoDecisionRef, 'cvoDecisionRef');
  const closures = parseBundleClosures(raw.closures, legacyBefore);
  if (!Array.isArray(raw.attachments)) throw new Error('legacy migration bundle attachments must be an array');
  const attachments = normalizeLegacyAttachments(raw.attachments.map(parseAttachment));
  const recoveryManifest = validateRecoveryManifest(raw.recoveryManifest);
  if (recoveryManifest.cvoDecisionRef !== cvoDecisionRef) {
    throw new Error('legacy migration bundle operator decision does not match recovery manifest');
  }
  assertAttachmentEvidenceCoverage(closures, attachments, recoveryManifest);
  return {
    version: 1,
    incident: 'F254-legacy-closure-migration',
    generatedAt,
    legacyBeforeExclusive,
    cvoDecisionRef,
    closures,
    attachments,
    recoveryManifest,
  };
}

export function validateLegacyClosureMigrationBundle(raw: unknown): LegacyClosureMigrationBundle {
  const normalized = normalizeBundle(raw);
  const bundleSha256 = sha256Text(stableJson(normalized));
  if (isRecord(raw) && raw.bundleSha256 !== undefined && raw.bundleSha256 !== bundleSha256) {
    throw new Error('legacy migration bundleSha256 mismatch');
  }
  return { ...normalized, bundleSha256 };
}

export function buildLegacyClosureMigrationBundle(
  input: Omit<LegacyClosureMigrationBundle, 'version' | 'incident' | 'bundleSha256'>,
): LegacyClosureMigrationBundle {
  return validateLegacyClosureMigrationBundle({
    version: 1,
    incident: 'F254-legacy-closure-migration',
    ...input,
  });
}

export function assertLegacyClosureMigrationWriteAllowed(
  redisUrl: string,
  bundle: LegacyClosureMigrationBundle,
  authorization:
    | { mode: 'preview' }
    | { mode: 'isolated_test' }
    | {
        mode: 'production';
        approvalRef?: string;
        expectedBundleSha256?: string;
        confirmation?: string;
      },
): void {
  const parsed = new URL(redisUrl);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
  if (authorization.mode === 'isolated_test') {
    const database = Number.parseInt(parsed.pathname.replace(/^\//, ''), 10);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    if (process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1') {
      throw new Error('isolated migration writes require the sanctioned Redis test harness');
    }
    if (!loopback || !Number.isSafeInteger(database) || database < 15) {
      throw new Error('isolated migration writes require loopback Redis with database >= 15');
    }
    if (port === 6398 || port === 6399 || port === 6401) {
      throw new Error(`isolated migration writes refuse protected Redis port ${port}`);
    }
    return;
  }
  if (port === 6398) {
    if (authorization.mode !== 'preview') throw new Error('production authorization cannot target preview Redis 6398');
    return;
  }
  if (port !== 6399) {
    throw new Error(
      `legacy migration writes are restricted to preview Redis 6398 or production Redis 6399, got ${port}`,
    );
  }
  if (authorization.mode !== 'production') {
    throw new Error('production Redis 6399 write refused without production authorization');
  }
  requireString(authorization.approvalRef, 'production approvalRef');
  if (authorization.expectedBundleSha256 !== bundle.bundleSha256) {
    throw new Error('production legacy migration bundle hash does not match the approved hash');
  }
  if (authorization.confirmation !== PRODUCTION_CONFIRMATION) {
    throw new Error(`production legacy migration confirmation must equal ${PRODUCTION_CONFIRMATION}`);
  }
}
