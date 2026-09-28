import { PawFeelDispositionService } from '../../../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';

export const T0 = Date.parse('2026-07-26T00:00:00.000Z');

export class MemoryPawFeelEventLog {
  events = new Map();
  eventOwners = new Map();

  async append(event, expectedSequence) {
    const owner = this.eventOwners.get(event.eventId);
    if (owner) return { outcome: 'duplicate' };
    const current = this.events.get(event.signalId) ?? [];
    if (current.length !== expectedSequence) return { outcome: 'conflict', actualSequence: current.length };
    this.eventOwners.set(event.eventId, event.signalId);
    this.events.set(event.signalId, [...current, event]);
    return { outcome: 'appended', sequence: current.length };
  }

  async read(signalId, fromSequence = 0) {
    return (this.events.get(signalId) ?? []).slice(fromSequence);
  }

  async listSignalIds() {
    return [...this.events.keys()].sort();
  }

  async scanSignalIds(cursor, limit) {
    const signalIds = await this.listSignalIds();
    const offset = cursor ? Number(cursor.redisCursor) : 0;
    const page = signalIds.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      signalIds: page,
      scanCalls: 1,
      ...(nextOffset < signalIds.length
        ? {
            nextCursor: {
              redisCursor: String(nextOffset),
              pendingSignalIds: [],
              completeAfterPending: false,
            },
          }
        : {}),
    };
  }
}

export function pawFeelCandidate({
  messageId = 'message-1',
  digest = 'a'.repeat(64),
  ordinal = 0,
  markerIndex = 0,
  sourceCatId = 'codex-sol',
} = {}) {
  return {
    signalId: `${messageId}:${digest}:${ordinal}`,
    sourceMessageId: messageId,
    sourceThreadId: 'thread-source',
    sourceCatId,
    markerDigest: digest,
    sameDigestOrdinal: ordinal,
    markerIndex,
    occurredAt: new Date(T0 - 60_000).toISOString(),
    marker: { raw: '[爪感差: rg+输出太吵]', tool: 'rg', symptom: '输出太吵' },
  };
}

export function pawFeelCommand(type, signalId, expectedSequence, overrides = {}) {
  return {
    type,
    eventId: `event-${type}-${expectedSequence}`,
    signalId,
    expectedSequence,
    ...overrides,
  };
}

export function createPawFeelServiceHarness({
  resolveFix = async (leaseId) => {
    if (leaseId !== 'lease-active') throw new Error('lease not active');
    return {
      ownerCatId: 'opus',
      taskId: 'task-1',
      leaseId,
      leaseGeneration: 3,
      custodyEvidenceRef: 'action-lease:lease-active:generation:3',
    };
  },
  assertBundleSnapshot = async () => {},
} = {}) {
  let tick = 0;
  const eventLog = new MemoryPawFeelEventLog();
  const service = new PawFeelDispositionService({
    eventLog,
    fixResolver: { resolve: resolveFix },
    directRepairResolver: {
      async resolve({ projection, leaseId }) {
        const fix = await resolveFix(leaseId);
        const ownerRef = (ownerFeatureId, ownerStateRef, version) => ({
          ownerFeatureId,
          ownerStateRef,
          ...(version ? { version } : {}),
        });
        return {
          status: 'authorized',
          fix,
          binding: {
            schemaVersion: 1,
            bindingRef: ownerRef('F278', `paw-feel-direct-repair-binding:${projection.signalId}:${leaseId}`),
            sourceSignalRef: ownerRef(
              'F278',
              `paw-feel-signal:${projection.signalId}`,
              `${projection.markerDigest}:${projection.sameDigestOrdinal}`,
            ),
            sourceToolRef: ownerRef('F278', 'paw-feel-tool:fixture'),
            providerId: 'fixture-provider',
            providerVersion: 'v1',
            providerRouteRef: ownerRef('F278', 'paw-feel-direct-repair-route:fixture-provider', 'v1'),
            resolvedActionRef: ownerRef('F278', `fixture-action:${leaseId}`),
            actionScopeRef: ownerRef('F278', 'fixture-action-scope:paw-feel'),
            ownerAuthorizationRef: ownerRef('F278', 'fixture-authorization:existing'),
            targetVersionRef: {
              ...ownerRef('F278', `fixture-target:${leaseId}`, 'v1'),
              assetKind: 'fixture',
              assetId: leaseId,
            },
            ownerCatId: fix.ownerCatId,
            outcomeVerifierRef: ownerRef('F278', 'fixture-outcome-verifier:v1'),
          },
        };
      },
    },
    resumeConditionResolver: {
      async resolve(selector) {
        return {
          normalizedSelector: selector,
          state: 'waiting',
          version: JSON.stringify(selector),
          satisfied: false,
          evidenceRefs: selector.kind === 'bounded_time' ? [] : [selector.ref],
        };
      },
    },
    bundleMembershipResolver: { assertBundleSnapshot },
    now: () => new Date(T0 + tick++ * 1_000).toISOString(),
  });
  return { eventLog, service };
}
