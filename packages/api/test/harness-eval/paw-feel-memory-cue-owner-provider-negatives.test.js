import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derivePawFeelProviderRouteRef } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import {
  F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
  MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE,
  MemoryCuePawFeelDirectRepairOwnerProvider,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/providers/memory-cue-owner-provider.js';

const USER_ID = 'owner-1';
const BASE = '1'.repeat(40);
const LOADED = '2'.repeat(40);
const MAIN = '3'.repeat(40);
const AUTH_MESSAGE = {
  id: '0001788794400596-000676-4c986166',
  threadId: 'thread_mtr73addr1o2oncx',
  userId: USER_ID,
  catId: null,
  content:
    '我感觉如果这个工具是给你们用的哈哈哈 别找我了 就算涉及api啥的，这其实也不是对外的什么，毕竟也不是给人用的！是给猫猫用的！你们才最懂自己！按照想要的修了就得了！？ 😁 我们爪感差 是f313吗？ 现在他的进展啥情况了啊？ 还是咋的，他们考虑到我们这个thread说的这些了吗？',
  mentions: [],
  timestamp: 1_788_794_400_596,
};
const source = {
  sourceSignalRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel-signal:signal-1' },
  sourceToolRef: { ownerFeatureId: 'F287', ownerStateRef: 'mcp-tool:cat_cafe_record_memory_cue_outcome' },
  markerDigest: 'a'.repeat(64),
  sameDigestOrdinal: 0,
};
const custody = {
  ownerCatId: 'codex-sol',
  taskId: 'task-1',
  leaseId: 'lease-1',
  leaseGeneration: 1,
  custodyEvidenceRef: 'action-lease:lease-1:generation:1',
};

function gitTruth({ loadedRevision = BASE, relevant = true, onMain = true } = {}) {
  return {
    loadedRevision,
    async currentMainRevision() {
      return loadedRevision === BASE ? BASE : MAIN;
    },
    async isAncestor(ancestor, descendant) {
      if (ancestor === descendant) return true;
      if (ancestor === BASE && descendant === LOADED) return true;
      if (ancestor === LOADED && descendant === MAIN) return onMain;
      return false;
    },
    async changedFiles() {
      return [relevant ? 'packages/mcp-server/src/tools/memory-cue-tools.ts' : 'README.md'];
    },
  };
}

function provider({ event = null, loadedAtMs = 2_000, git = gitTruth() } = {}) {
  return new MemoryCuePawFeelDirectRepairOwnerProvider({
    messageStore: {
      async getById(messageId) {
        return messageId === AUTH_MESSAGE.id ? AUTH_MESSAGE : null;
      },
    },
    episodeStore: { getByEventId: () => event },
    ownerUserId: USER_ID,
    loadedAtMs,
    gitTruth: git,
  });
}

async function binding() {
  const decision = await provider().resolveAuthority({
    source,
    custody,
    actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
  });
  assert.equal(decision.status, 'authorized');
  return {
    ...decision.authority,
    bindingRef: { ownerFeatureId: 'F278', ownerStateRef: `paw-feel-direct-repair-binding:sha256:${'b'.repeat(64)}` },
    sourceSignalRef: source.sourceSignalRef,
    sourceToolRef: source.sourceToolRef,
    providerId: MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE.providerId,
    providerVersion: MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE.providerVersion,
    providerRouteRef: derivePawFeelProviderRouteRef(MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE),
  };
}

function event(overrides = {}) {
  return {
    eventId: 'outcome-1',
    idempotencyKey: 'outcome-1',
    cueId: 'cue-1',
    opportunityId: 'opportunity-1',
    scope: { ownerUserId: USER_ID, threadId: 'thread-1', invocationId: 'invocation-1' },
    consumerCatId: 'codex-sol',
    resolverFamily: 'person_entity',
    sourceAnchor: 'person:alden',
    sourceRevision: 'revision-1',
    axis: 'consumption',
    consumptionOutcome: 'applied',
    invalidationReason: null,
    catalogVersion: 5,
    resolverVersion: 1,
    occurredAt: 3_000,
    createdAt: '2026-09-09T00:00:03.000Z',
    ...overrides,
  };
}

const terminals = {
  taskTerminalRef: { ownerFeatureId: 'F310', ownerStateRef: 'task-terminal:task-1', version: '2' },
  leaseTerminalRef: { ownerFeatureId: 'F167', ownerStateRef: 'action-terminal:lease-1', version: '1:2' },
};

describe('F313/F287 owner outcome negatives', () => {
  it('blocks admission when loaded target is not contained by current main', async () => {
    const result = await provider({ git: gitTruth({ onMain: false }) }).resolveAuthority({
      source,
      custody,
      actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
    });
    assert.equal(result.status, 'authorized', 'equal loaded/main is a valid admission baseline');

    const drifted = provider({
      git: { ...gitTruth(), currentMainRevision: async () => MAIN, isAncestor: async () => false },
    });
    const blocked = await drifted.resolveAuthority({
      source,
      custody,
      actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.reason, 'target_mismatch');
  });

  it('rejects stale or foreign events, unrelated deltas, and a loaded revision outside main', async () => {
    const canonicalBinding = await binding();
    const goodEvent = event();
    const ownerOutcomeRef = {
      ownerFeatureId: 'F287',
      ownerStateRef: `memory-cue-consumption:${goodEvent.eventId}`,
      version: goodEvent.createdAt,
    };
    const cases = [
      provider({ event: event({ occurredAt: 1_000 }), git: gitTruth({ loadedRevision: LOADED }) }),
      provider({ event: event({ consumerCatId: 'opus' }), git: gitTruth({ loadedRevision: LOADED }) }),
      provider({ event: goodEvent, git: gitTruth({ loadedRevision: LOADED, relevant: false }) }),
      provider({
        event: goodEvent,
        git: {
          ...gitTruth({ loadedRevision: LOADED }),
          async changedFiles() {
            return ['packages/api/src/domains/memory/cue/sources/EventMemoryCueSource.ts'];
          },
        },
      }),
      provider({ event: goodEvent, git: gitTruth({ loadedRevision: LOADED, onMain: false }) }),
    ];

    for (const candidate of cases) {
      await assert.rejects(
        candidate.verifyOutcome({ binding: canonicalBinding, ownerOutcomeRef, ...terminals }),
        /outcome|delta|main/i,
      );
    }
  });
});
