import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { inspectPawFeelMessage } from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelDirectRepairBindingVerifier } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-binding-verifier.js';
import { PawFeelDirectRepairFederation } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairOutcomeResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-outcome-resolver.js';
import { PawFeelDirectRepairResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-resolver.js';
import {
  defaultPawFeelSourceToolClassifier,
  PawFeelDirectRepairSourceVerifier,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-source.js';
import {
  F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
  MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE,
  MemoryCuePawFeelDirectRepairOwnerProvider,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/providers/memory-cue-owner-provider.js';

const OWNER_USER_ID = 'owner-1';
const OWNER_CAT_ID = 'codex-sol';
const BASE_REVISION = '1'.repeat(40);
const LOADED_REVISION = '2'.repeat(40);
const MAIN_REVISION = '3'.repeat(40);
const AUTHORIZATION_MESSAGE = {
  id: '0001788794400596-000676-4c986166',
  threadId: 'thread_mtr73addr1o2oncx',
  userId: OWNER_USER_ID,
  catId: null,
  content:
    '我感觉如果这个工具是给你们用的哈哈哈 别找我了 就算涉及api啥的，这其实也不是对外的什么，毕竟也不是给人用的！是给猫猫用的！你们才最懂自己！按照想要的修了就得了！？ 😁 我们爪感差 是f313吗？ 现在他的进展啥情况了啊？ 还是咋的，他们考虑到我们这个thread说的这些了吗？',
  mentions: [],
  timestamp: 1_788_794_400_596,
};
const SOURCE_MESSAGE = {
  id: 'message-memory-cue-paw-feel',
  threadId: 'thread-memory-cue-paw-feel',
  userId: OWNER_USER_ID,
  catId: OWNER_CAT_ID,
  content: '[爪感差: cat_cafe_record_memory_cue_outcome+成功结果没有可回链的 outcome ref]',
  mentions: [],
  timestamp: 1_788_800_000_000,
};
const inspected = inspectPawFeelMessage(SOURCE_MESSAGE);
assert.equal(inspected.kind, 'canonical');
const candidate = inspected.candidates[0];

function sourceProjection(overrides = {}) {
  return {
    signalId: candidate.signalId,
    sourceMessageId: candidate.sourceMessageId,
    sourceThreadId: candidate.sourceThreadId,
    sourceCatId: candidate.sourceCatId,
    markerDigest: candidate.markerDigest,
    sameDigestOrdinal: candidate.sameDigestOrdinal,
    markerIndex: candidate.markerIndex,
    state: 'seen',
    sequence: 1,
    discoveredAt: '2026-09-09T00:00:00.000Z',
    lastTransitionAt: '2026-09-09T00:00:00.000Z',
    backfilled: false,
    captureMethod: 'typed',
    captureAssessment: 'confirmed',
    ...overrides,
  };
}

function messageStore(authorization = AUTHORIZATION_MESSAGE) {
  return {
    async getById(messageId) {
      if (messageId === SOURCE_MESSAGE.id) return SOURCE_MESSAGE;
      if (messageId === AUTHORIZATION_MESSAGE.id) return authorization;
      return null;
    },
  };
}

function gitTruth({ loadedRevision = BASE_REVISION, mainRevision = BASE_REVISION, changedFiles = [] } = {}) {
  return {
    loadedRevision,
    async currentMainRevision() {
      return mainRevision;
    },
    async isAncestor(ancestor, descendant) {
      return (
        ancestor === descendant ||
        (ancestor === BASE_REVISION && descendant === LOADED_REVISION) ||
        (ancestor === BASE_REVISION && descendant === MAIN_REVISION) ||
        (ancestor === LOADED_REVISION && descendant === MAIN_REVISION)
      );
    },
    async changedFiles() {
      return changedFiles;
    },
  };
}

function ownerProvider({ episodeStore, authorization, loadedAtMs = 2_000, git = gitTruth() }) {
  return new MemoryCuePawFeelDirectRepairOwnerProvider({
    messageStore: messageStore(authorization),
    episodeStore,
    ownerUserId: OWNER_USER_ID,
    loadedAtMs,
    gitTruth: git,
  });
}

describe('F313/F287 concrete memory-cue direct-repair owner provider', () => {
  it('routes the exact source tool and accepts only the named owner action with independent owner authority', async () => {
    const sourceToolRef = defaultPawFeelSourceToolClassifier('cat_cafe_record_memory_cue_outcome');
    assert.deepEqual(sourceToolRef, {
      ownerFeatureId: 'F287',
      ownerStateRef: 'mcp-tool:cat_cafe_record_memory_cue_outcome',
    });

    const provider = ownerProvider({ episodeStore: { getByEventId: () => null } });
    const source = {
      sourceSignalRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel-signal:signal-1' },
      sourceToolRef,
      markerDigest: 'a'.repeat(64),
      sameDigestOrdinal: 0,
    };
    const custody = {
      ownerCatId: OWNER_CAT_ID,
      taskId: 'task-1',
      leaseId: 'lease-1',
      leaseGeneration: 1,
      custodyEvidenceRef: 'action-lease:lease-1:generation:1',
    };

    assert.equal((await provider.resolveAuthority({ source, custody, actionRef: 'foreign-action' })).status, 'blocked');
    const authority = await provider.resolveAuthority({
      source,
      custody,
      actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
    });
    assert.equal(authority.status, 'authorized');
    assert.equal(authority.authority.ownerCatId, OWNER_CAT_ID);
    assert.equal(authority.authority.ownerAuthorizationRef.ownerFeatureId, 'F313');
    assert.equal(authority.authority.targetVersionRef.version, BASE_REVISION);
    assert.equal(authority.authority.targetVersionRef.assetId, 'cat_cafe_record_memory_cue_outcome');

    const wrongOwner = await provider.resolveAuthority({
      source,
      custody: { ...custody, ownerCatId: 'opus' },
      actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
    });
    assert.deepEqual(wrongOwner.status, 'blocked');
    assert.equal(wrongOwner.reason, 'owner_mismatch');
  });

  it('fails closed when the immutable operator authorization body drifts', async () => {
    const provider = ownerProvider({
      episodeStore: { getByEventId: () => null },
      authorization: { ...AUTHORIZATION_MESSAGE, content: `${AUTHORIZATION_MESSAGE.content} changed` },
    });
    await assert.rejects(
      provider.resolveAuthority({
        source: {
          sourceSignalRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel-signal:signal-1' },
          sourceToolRef: { ownerFeatureId: 'F287', ownerStateRef: 'mcp-tool:cat_cafe_record_memory_cue_outcome' },
          markerDigest: 'a'.repeat(64),
          sameDigestOrdinal: 0,
        },
        custody: {
          ownerCatId: OWNER_CAT_ID,
          taskId: 'task-1',
          leaseId: 'lease-1',
          leaseGeneration: 1,
          custodyEvidenceRef: 'action-lease:lease-1:generation:1',
        },
        actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
      }),
      /authorization/i,
    );
  });

  it('closes a real source → binding → F287 event → merged-and-loaded outcome journey', async () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      const episodeStore = new MemoryCueEpisodeStore(db, { nowIso: () => '2026-09-09T00:00:03.000Z' });
      const sourceVerifier = new PawFeelDirectRepairSourceVerifier({
        messageStore: messageStore(),
        classifyTool: defaultPawFeelSourceToolClassifier,
      });
      const admissionProvider = ownerProvider({ episodeStore });
      const admissionFederation = new PawFeelDirectRepairFederation([
        { route: MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE, provider: admissionProvider },
      ]);
      const resolver = new PawFeelDirectRepairResolver({
        sourceVerifier,
        federation: admissionFederation,
        custodyResolver: {
          async resolve(leaseId) {
            return {
              ownerCatId: OWNER_CAT_ID,
              taskId: 'task-1',
              leaseId,
              leaseGeneration: 1,
              custodyEvidenceRef: `action-lease:${leaseId}:generation:1`,
            };
          },
        },
        approvalContinuationResolver: {
          async resolve() {
            throw new Error('existing owner authority must not create Approval');
          },
        },
      });

      const admission = await resolver.resolve({
        projection: sourceProjection(),
        leaseId: 'lease-1',
        actionRef: F287_MEMORY_CUE_OUTCOME_REPAIR_ACTION,
      });
      assert.equal(admission.status, 'authorized');
      assert.equal(admission.binding.ownerAuthorizationRef.ownerFeatureId, 'F313');

      const cueBase = {
        cueId: 'cue-1',
        opportunityId: 'opportunity-1',
        scope: { ownerUserId: OWNER_USER_ID, threadId: 'thread-1', invocationId: 'invocation-1' },
        consumerCatId: OWNER_CAT_ID,
        resolverFamily: 'person_entity',
        sourceAnchor: 'person:alden',
        sourceRevision: 'revision-1',
        catalogVersion: 5,
        resolverVersion: 1,
      };
      episodeStore.append({
        ...cueBase,
        eventId: 'presented-1',
        idempotencyKey: 'presented-1',
        axis: 'consumption',
        consumptionOutcome: 'presented',
        occurredAt: 2_500,
      });
      const event = episodeStore.append({
        ...cueBase,
        eventId: 'outcome-1',
        idempotencyKey: 'outcome-1',
        axis: 'consumption',
        consumptionOutcome: 'applied',
        occurredAt: 3_000,
      });
      const ownerOutcomeRef = {
        ownerFeatureId: 'F287',
        ownerStateRef: `memory-cue-consumption:${event.eventId}`,
        version: event.createdAt,
      };
      const loadedProvider = ownerProvider({
        episodeStore,
        loadedAtMs: 2_750,
        git: gitTruth({
          loadedRevision: LOADED_REVISION,
          mainRevision: MAIN_REVISION,
          changedFiles: ['packages/api/src/routes/callback-memory-cue-routes.ts'],
        }),
      });
      const loadedFederation = new PawFeelDirectRepairFederation([
        { route: MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE, provider: loadedProvider },
      ]);
      const fixProjection = sourceProjection({
        state: 'fix',
        sequence: 2,
        ownerCatId: OWNER_CAT_ID,
        taskId: 'task-1',
        actionLeaseRef: { leaseId: 'lease-1', generation: 1 },
        custodyEvidenceRef: 'action-lease:lease-1:generation:1',
        directRepairBinding: admission.binding,
      });
      const outcomeResolver = new PawFeelDirectRepairOutcomeResolver({
        bindingVerifier: new PawFeelDirectRepairBindingVerifier({ sourceVerifier, federation: loadedFederation }),
        terminalResolver: {
          async resolve() {
            return {
              ownerCatId: OWNER_CAT_ID,
              taskTerminalRef: { ownerFeatureId: 'F310', ownerStateRef: 'task-terminal:task-1', version: '2' },
              leaseTerminalRef: {
                ownerFeatureId: 'F167',
                ownerStateRef: 'action-successor-terminal:lease-1',
                version: '1:2',
              },
            };
          },
        },
      });

      const outcome = await outcomeResolver.resolve({
        projection: fixProjection,
        actor: { kind: 'cat', id: OWNER_CAT_ID },
        bindingRef: admission.binding.bindingRef,
        ownerOutcomeRef,
      });
      assert.equal(outcome.disposition, 'verified_changed');
      assert.deepEqual(outcome.ownerOutcomeRef, ownerOutcomeRef);
      assert.ok(outcome.verificationRefs.some((ref) => ref.ownerStateRef.startsWith('loaded-runtime:')));
      assert.equal('payload' in outcome, false);
    } finally {
      db.close();
    }
  });
});
