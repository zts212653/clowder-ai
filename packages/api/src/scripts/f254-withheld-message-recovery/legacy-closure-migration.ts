import type { FreshnessClosureAggregate, LegacyClosureMigrationOutcomeCounts } from '@cat-cafe/shared';
import type { MigrateLegacyFreshnessClosureInput } from '../../domains/cats/services/freshness/freshness-closure-store-types.js';
import type { StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import { planRecovery, type RecoveryPlanItem } from './core.js';
import { type RecoveryManifestEntry, sha256Text, type ValidatedRecoveryManifest } from './manifest.js';

export type LegacyClosureInvocationOutcome =
  | 'already_formal_exact'
  | 'already_recovered_exact'
  | 'recoverable_text'
  | 'no_text'
  | 'conflict';

export interface LegacyWithheldAttachment {
  closureId: string;
  invocationId: string;
  source: 'legacy_census' | 'runtime_log';
  evidenceRefs: string[];
  withheldDecision?: {
    withheldAtUtc: string;
    closureId: string;
    decisionKind: string;
  };
}

export type LegacyClosureInventoryItem = Pick<
  FreshnessClosureAggregate,
  'id' | 'userId' | 'threadId' | 'catId' | 'status' | 'revision' | 'createdAt' | 'updatedAt'
>;

export interface LegacyClosureInvocationAccounting {
  invocationId: string;
  outcome: LegacyClosureInvocationOutcome;
  contentSha256?: string;
  messageId?: string;
  evidenceRefs: string[];
  reason?: string;
}

export interface LegacyClosureAccounting {
  closureId: string;
  expectedRevision: number;
  userId: string;
  threadId: string;
  catId: string;
  invocations: LegacyClosureInvocationAccounting[];
  issues: string[];
  fullyAccounted: boolean;
}

export interface LegacyClosureMigrationPlan {
  version: 1;
  incident: 'F254-legacy-closure-migration';
  generatedAt: string;
  cvoDecisionRef: string;
  recoveryManifestSha256: string;
  inventorySha256: string;
  migrationManifestSha256: string;
  attachments: LegacyWithheldAttachment[];
  closures: LegacyClosureAccounting[];
  summary: Record<LegacyClosureInvocationOutcome, number>;
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

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`legacy closure migration ${field} must be non-empty`);
  return normalized;
}

export function normalizeLegacyAttachments(raw: readonly LegacyWithheldAttachment[]): LegacyWithheldAttachment[] {
  const byInvocation = new Map<string, LegacyWithheldAttachment>();
  for (const attachment of raw) {
    const closureId = requireText(attachment.closureId, 'closureId');
    const invocationId = requireText(attachment.invocationId, 'invocationId');
    if (attachment.source !== 'legacy_census' && attachment.source !== 'runtime_log') {
      throw new Error(`legacy closure migration ${invocationId} has invalid source`);
    }
    const evidenceRefs = [...new Set(attachment.evidenceRefs.map((ref) => requireText(ref, 'evidenceRef')))].sort();
    if (evidenceRefs.length === 0) throw new Error(`legacy closure migration ${invocationId} requires evidence`);
    const existing = byInvocation.get(invocationId);
    if (existing && existing.closureId !== closureId) {
      throw new Error(`withheld invocation ${invocationId} is attached to multiple closures`);
    }
    byInvocation.set(invocationId, {
      closureId,
      invocationId,
      source: existing?.source === 'legacy_census' ? existing.source : attachment.source,
      evidenceRefs: [...new Set([...(existing?.evidenceRefs ?? []), ...evidenceRefs])].sort(),
      ...(() => {
        const decisions = [existing?.withheldDecision, attachment.withheldDecision].filter(
          (decision): decision is NonNullable<LegacyWithheldAttachment['withheldDecision']> => Boolean(decision),
        );
        if (decisions.length === 0) return {};
        if (decisions.some((decision) => decision.closureId !== closureId)) {
          throw new Error(`withheld invocation ${invocationId} decision points to a different closure`);
        }
        const selected = decisions.sort((left, right) => left.withheldAtUtc.localeCompare(right.withheldAtUtc))[0];
        return selected ? { withheldDecision: { ...selected } } : {};
      })(),
    });
  }
  return [...byInvocation.values()].sort(
    (left, right) =>
      left.closureId.localeCompare(right.closureId) || left.invocationId.localeCompare(right.invocationId),
  );
}

function sourceEvidence(entry: RecoveryManifestEntry): string {
  const proof = entry.sourceProof;
  return `transcript:${proof.transcriptPath}#events=${proof.firstEventNo}-${proof.lastEventNo};terminal=${proof.terminalEventNo}`;
}

function conflict(
  attachment: LegacyWithheldAttachment,
  reason: string,
  entry?: RecoveryManifestEntry,
): LegacyClosureInvocationAccounting {
  return {
    invocationId: attachment.invocationId,
    outcome: 'conflict',
    ...(entry ? { contentSha256: entry.contentSha256 } : {}),
    evidenceRefs: [...attachment.evidenceRefs],
    reason,
  };
}

interface AccountingIndexes {
  entries: ReadonlyMap<string, RecoveryManifestEntry>;
  omissions: ReadonlySet<string>;
  recoveryItems: ReadonlyMap<string, RecoveryPlanItem>;
}

function entryIdentityConflict(closure: LegacyClosureInventoryItem, entry: RecoveryManifestEntry): string | undefined {
  if (entry.threadId !== closure.threadId || entry.userId !== closure.userId || entry.catId !== closure.catId) {
    return 'recovery entry scope does not match closure scope';
  }
  const decision = entry.sourceProof.withheldDecision;
  return decision && decision.closureId !== closure.id
    ? 'transcript withheld decision points to a different closure'
    : undefined;
}

function accountRecoveryItem(
  attachment: LegacyWithheldAttachment,
  entry: RecoveryManifestEntry,
  recovery: RecoveryPlanItem,
): LegacyClosureInvocationAccounting {
  const evidenceRefs = [...new Set([...attachment.evidenceRefs, sourceEvidence(entry)])].sort();
  if (recovery.outcome === 'conflict') {
    return { ...conflict(attachment, recovery.reason ?? 'exact identity conflict', entry), evidenceRefs };
  }
  if (recovery.outcome === 'insert' || recovery.outcome === 'insert_stream_companion') {
    return {
      invocationId: entry.invocationId,
      outcome: 'recoverable_text',
      contentSha256: entry.contentSha256,
      evidenceRefs,
      reason: recovery.reason,
    };
  }
  return {
    invocationId: entry.invocationId,
    outcome: recovery.outcome === 'already_restored' ? 'already_recovered_exact' : 'already_formal_exact',
    contentSha256: entry.contentSha256,
    messageId: recovery.existingMessageId,
    evidenceRefs,
  };
}

function accountAttachment(
  closure: LegacyClosureInventoryItem,
  attachment: LegacyWithheldAttachment,
  indexes: AccountingIndexes,
): LegacyClosureInvocationAccounting {
  if (indexes.omissions.has(attachment.invocationId)) {
    return {
      invocationId: attachment.invocationId,
      outcome: 'no_text',
      evidenceRefs: [...attachment.evidenceRefs],
    };
  }
  const entry = indexes.entries.get(attachment.invocationId);
  if (!entry) return conflict(attachment, 'invocation is absent from recovery entries and no-text omissions');
  const identityConflict = entryIdentityConflict(closure, entry);
  if (identityConflict) return conflict(attachment, identityConflict, entry);
  const recovery = indexes.recoveryItems.get(entry.invocationId);
  if (!recovery) return conflict(attachment, 'recovery plan omitted invocation', entry);
  return accountRecoveryItem(attachment, entry, recovery);
}

export function buildLegacyClosureMigrationPlan(input: {
  activeClosures: readonly LegacyClosureInventoryItem[];
  attachments: readonly LegacyWithheldAttachment[];
  recoveryManifest: ValidatedRecoveryManifest;
  existingMessages: readonly StoredMessage[];
  generatedAt: string;
}): LegacyClosureMigrationPlan {
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error('legacy migration generatedAt must be ISO');
  const activeClosures = [...input.activeClosures].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(activeClosures.map((closure) => closure.id)).size !== activeClosures.length) {
    throw new Error('legacy migration active closure inventory contains duplicates');
  }
  const activeIds = new Set(activeClosures.map((closure) => closure.id));
  const attachments = normalizeLegacyAttachments(input.attachments).filter((item) => activeIds.has(item.closureId));
  const attachmentGroups = new Map<string, LegacyWithheldAttachment[]>();
  for (const attachment of attachments) {
    const group = attachmentGroups.get(attachment.closureId) ?? [];
    group.push(attachment);
    attachmentGroups.set(attachment.closureId, group);
  }
  const indexes: AccountingIndexes = {
    entries: new Map(input.recoveryManifest.entries.map((entry) => [entry.invocationId, entry])),
    omissions: new Set((input.recoveryManifest.omissions ?? []).map((item) => item.invocationId)),
    recoveryItems: new Map(
      planRecovery(input.recoveryManifest, input.existingMessages).items.map((item) => [item.entry.invocationId, item]),
    ),
  };
  const summary: Record<LegacyClosureInvocationOutcome, number> = {
    already_formal_exact: 0,
    already_recovered_exact: 0,
    recoverable_text: 0,
    no_text: 0,
    conflict: 0,
  };
  const closures = activeClosures.map((closure): LegacyClosureAccounting => {
    const attached = attachmentGroups.get(closure.id) ?? [];
    const issues = attached.length === 0 ? ['no_withheld_invocation_inventory'] : [];
    const invocations = attached.map((attachment) => accountAttachment(closure, attachment, indexes));
    for (const item of invocations) summary[item.outcome] += 1;
    summary.conflict += issues.length;
    return {
      closureId: closure.id,
      expectedRevision: closure.revision,
      userId: closure.userId,
      threadId: closure.threadId,
      catId: closure.catId,
      invocations,
      issues,
      fullyAccounted:
        issues.length === 0 &&
        invocations.length > 0 &&
        invocations.every((item) => item.outcome !== 'recoverable_text' && item.outcome !== 'conflict'),
    };
  });
  const inventory = {
    closures: activeClosures.map((closure) => ({
      closureId: closure.id,
      revision: closure.revision,
      userId: closure.userId,
      threadId: closure.threadId,
      catId: closure.catId,
      status: closure.status,
    })),
    attachments,
  };
  const inventorySha256 = sha256Text(stableJson(inventory));
  const manifestIdentity = {
    version: 1,
    incident: 'F254-legacy-closure-migration',
    generatedAt: input.generatedAt,
    cvoDecisionRef: input.recoveryManifest.cvoDecisionRef,
    recoveryManifestSha256: input.recoveryManifest.manifestSha256,
    inventorySha256,
  } as const;
  return {
    ...manifestIdentity,
    migrationManifestSha256: sha256Text(stableJson(manifestIdentity)),
    attachments,
    closures,
    summary,
  };
}

export function buildLegacyClosureTerminalInput(
  plan: LegacyClosureMigrationPlan,
  closureId: string,
  input: { actorId: string; evidenceRef: string; now: number },
): MigrateLegacyFreshnessClosureInput {
  const closure = plan.closures.find((item) => item.closureId === closureId);
  if (!closure) throw new Error(`legacy closure migration plan does not contain ${closureId}`);
  if (!closure.fullyAccounted) throw new Error(`legacy closure ${closureId} is not fully accounted`);
  const outcomeCounts: LegacyClosureMigrationOutcomeCounts = {
    already_formal_exact: 0,
    already_recovered_exact: 0,
    no_text: 0,
  };
  const messageIds: string[] = [];
  for (const item of closure.invocations) {
    if (item.outcome === 'recoverable_text' || item.outcome === 'conflict') {
      throw new Error(`legacy closure ${closureId} is not fully accounted`);
    }
    outcomeCounts[item.outcome] += 1;
    if (item.outcome !== 'no_text') {
      if (!item.messageId) throw new Error(`legacy closure ${closureId} exact formal outcome lacks messageId`);
      messageIds.push(item.messageId);
    }
  }
  const accounting = {
    closureId,
    expectedRevision: closure.expectedRevision,
    invocations: closure.invocations,
  };
  return {
    expectedRevision: closure.expectedRevision,
    actorId: requireText(input.actorId, 'actorId'),
    evidenceRef: requireText(input.evidenceRef, 'evidenceRef'),
    manifestSha256: plan.migrationManifestSha256,
    accountingSha256: sha256Text(stableJson(accounting)),
    invocationIds: closure.invocations.map((item) => item.invocationId).sort(),
    messageIds: [...new Set(messageIds)].sort(),
    evidenceRefs: [input.evidenceRef, ...closure.invocations.flatMap((item) => item.evidenceRefs)]
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort(),
    outcomeCounts,
    now: input.now,
  };
}
