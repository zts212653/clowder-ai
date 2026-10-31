import { createHash } from 'node:crypto';
import { projectPawFeelDisposition } from '../projector.js';
import type { PawFeelDispositionService } from '../service.js';
import { deriveLegacyPawFeelBlockerReopenEventId, digestLegacyPawFeelBlockerEvent } from './blocker-reopen-identity.js';

type PawFeelMaintenanceService = Pick<
  PawFeelDispositionService,
  'listSignalIds' | 'readSignalEvents' | 'reopenBlocker'
>;

export interface LegacyPawFeelBlockerManifestEntry {
  signalId: string;
  blockingSequence: number;
  blockerEventDigest: string;
}

export interface LegacyPawFeelBlockerManifest {
  schemaVersion: 1;
  frozenAt: string;
  entries: LegacyPawFeelBlockerManifestEntry[];
  truncated: boolean;
  manifestDigest: string;
}

export interface LegacyPawFeelBlockerRecoveryReceipt {
  schemaVersion: 1;
  manifestDigest: string;
  productionDataAuthorizationRef: string;
  completedAt: string;
  counts: { applied: number; stale: number; idempotent: number };
  receiptDigest: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(tag: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([tag, canonicalize(value)]))
    .digest('hex');
}

function manifestCore(manifest: Omit<LegacyPawFeelBlockerManifest, 'manifestDigest'>) {
  return {
    schemaVersion: manifest.schemaVersion,
    frozenAt: manifest.frozenAt,
    entries: manifest.entries,
    truncated: manifest.truncated,
  };
}

export function createLegacyPawFeelBlockerManifest(input: {
  frozenAt: string;
  entries: readonly LegacyPawFeelBlockerManifestEntry[];
  truncated: boolean;
}): LegacyPawFeelBlockerManifest {
  const core = {
    schemaVersion: 1 as const,
    frozenAt: input.frozenAt,
    entries: [...input.entries].sort((left, right) => left.signalId.localeCompare(right.signalId)),
    truncated: input.truncated,
  };
  return { ...core, manifestDigest: digest('paw-feel-legacy-manifest:v1', core) };
}

export async function censusLegacyPawFeelBlockers(
  service: PawFeelMaintenanceService,
  options: { limit?: number; now?: () => string } = {},
): Promise<LegacyPawFeelBlockerManifest> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('legacy blocker census limit must be between 1 and 50');
  }
  const eligible: LegacyPawFeelBlockerManifestEntry[] = [];
  for (const signalId of await service.listSignalIds()) {
    const events = await service.readSignalEvents(signalId);
    if (events.length === 0) continue;
    const projection = projectPawFeelDisposition(events);
    if (projection.state !== 'blocked' || projection.blocker?.resumeCondition) continue;
    const blockingEvent = events[projection.sequence - 1];
    if (!blockingEvent || blockingEvent.type !== 'blocked' || blockingEvent.resumeCondition) continue;
    eligible.push({
      signalId,
      blockingSequence: projection.sequence,
      blockerEventDigest: digestLegacyPawFeelBlockerEvent(blockingEvent),
    });
  }
  eligible.sort((left, right) => left.signalId.localeCompare(right.signalId));
  return createLegacyPawFeelBlockerManifest({
    frozenAt: (options.now ?? (() => new Date().toISOString()))(),
    entries: eligible.slice(0, limit),
    truncated: eligible.length > limit,
  });
}

async function recoverEntry(input: {
  service: PawFeelMaintenanceService;
  entry: LegacyPawFeelBlockerManifestEntry;
  manifestDigest: string;
  productionDataAuthorizationRef: string;
  occurredAt: string;
}): Promise<'applied' | 'stale' | 'idempotent'> {
  const eventId = deriveLegacyPawFeelBlockerReopenEventId({
    signalId: input.entry.signalId,
    blockingSequence: input.entry.blockingSequence,
    blockerEventDigest: input.entry.blockerEventDigest,
    manifestDigest: input.manifestDigest,
  });
  const events = await input.service.readSignalEvents(input.entry.signalId);
  if (events.some((event) => event.eventId === eventId)) return 'idempotent';
  if (events.length !== input.entry.blockingSequence) return 'stale';
  const blockingEvent = events[input.entry.blockingSequence - 1];
  if (
    !blockingEvent ||
    blockingEvent.type !== 'blocked' ||
    blockingEvent.resumeCondition ||
    digestLegacyPawFeelBlockerEvent(blockingEvent) !== input.entry.blockerEventDigest
  ) {
    return 'stale';
  }
  const appended = await input.service.reopenBlocker({
    eventId,
    signalId: input.entry.signalId,
    expectedSequence: input.entry.blockingSequence,
    occurredAt: input.occurredAt,
    productionDataAuthorizationRef: input.productionDataAuthorizationRef,
    reopen: {
      kind: 'legacy_unbound',
      blockingSequence: input.entry.blockingSequence,
      blockerEventDigest: input.entry.blockerEventDigest,
      manifestDigest: input.manifestDigest,
    },
  });
  if (appended.outcome === 'appended') return 'applied';
  return appended.outcome === 'duplicate' ? 'idempotent' : 'stale';
}

export async function executeLegacyPawFeelBlockerRecovery(input: {
  service: PawFeelMaintenanceService;
  manifest: LegacyPawFeelBlockerManifest;
  productionDataAuthorizationRef?: string;
  now?: () => string;
}): Promise<LegacyPawFeelBlockerRecoveryReceipt> {
  const authorization = input.productionDataAuthorizationRef?.trim();
  if (!authorization) throw new Error('explicit production-data authorization is required');
  if (input.manifest.entries.length > 50) throw new Error('legacy blocker manifest exceeds 50 rows');
  const expectedManifestDigest = digest('paw-feel-legacy-manifest:v1', manifestCore(input.manifest));
  if (expectedManifestDigest !== input.manifest.manifestDigest)
    throw new Error('legacy blocker manifest digest mismatch');
  const counts = { applied: 0, stale: 0, idempotent: 0 };
  const occurredAt = (input.now ?? (() => new Date().toISOString()))();
  for (const entry of input.manifest.entries) {
    counts[
      await recoverEntry({
        service: input.service,
        entry,
        manifestDigest: input.manifest.manifestDigest,
        productionDataAuthorizationRef: authorization,
        occurredAt,
      })
    ] += 1;
  }
  const core = {
    schemaVersion: 1 as const,
    manifestDigest: input.manifest.manifestDigest,
    productionDataAuthorizationRef: authorization,
    completedAt: occurredAt,
    counts,
  };
  return { ...core, receiptDigest: digest('paw-feel-legacy-receipt:v1', core) };
}
