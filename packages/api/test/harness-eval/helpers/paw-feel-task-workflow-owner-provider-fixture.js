import assert from 'node:assert/strict';
import { TaskStore } from '../../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { inspectPawFeelMessage } from '../../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelDirectRepairFederation } from '../../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairResolver } from '../../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-resolver.js';
import {
  defaultPawFeelSourceToolClassifier,
  PawFeelDirectRepairSourceVerifier,
} from '../../../dist/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-source.js';
import {
  F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
  TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE,
  TaskWorkflowPawFeelDirectRepairOwnerProvider,
} from '../../../dist/infrastructure/harness-eval/paw-feel-disposition/providers/task-workflow-owner-provider.js';

export const OWNER_USER_ID = 'owner-1';
export const OWNER_CAT_ID = 'codex-sol';
export const BASE_REVISION = '1'.repeat(40);
export const LOADED_REVISION = '2'.repeat(40);
export const MAIN_REVISION = '3'.repeat(40);
export const SOURCE_MESSAGE = {
  id: '0001788781516802-000382-1871ebdc',
  threadId: 'thread_mtgr1e6xdhvieto9',
  userId: OWNER_USER_ID,
  catId: OWNER_CAT_ID,
  content:
    '[爪感差: cat_cafe_list_tasks 缺少 featureId 过滤，按猫查询返回约 50 万字符并被截断，只能改用 thread/task 精确过滤]',
  mentions: [],
  timestamp: 1_788_781_516_802,
};
export const AUTHORIZATION_MESSAGE = {
  id: '0001788794400596-000676-4c986166',
  threadId: 'thread_mtr73addr1o2oncx',
  userId: OWNER_USER_ID,
  catId: null,
  content:
    '我感觉如果这个工具是给你们用的哈哈哈 别找我了 就算涉及api啥的，这其实也不是对外的什么，毕竟也不是给人用的！是给猫猫用的！你们才最懂自己！按照想要的修了就得了！？ 😁 我们爪感差 是f313吗？ 现在他的进展啥情况了啊？ 还是咋的，他们考虑到我们这个thread说的这些了吗？',
  mentions: [],
  timestamp: 1_788_794_400_596,
};

const inspected = inspectPawFeelMessage(SOURCE_MESSAGE);
assert.equal(inspected.kind, 'canonical');
const sourceCandidate = inspected.candidates[0];

export function sourceProjection(overrides = {}) {
  return {
    signalId: sourceCandidate.signalId,
    sourceMessageId: sourceCandidate.sourceMessageId,
    sourceThreadId: sourceCandidate.sourceThreadId,
    sourceCatId: sourceCandidate.sourceCatId,
    markerDigest: sourceCandidate.markerDigest,
    sameDigestOrdinal: sourceCandidate.sameDigestOrdinal,
    markerIndex: sourceCandidate.markerIndex,
    state: 'seen',
    sequence: 1,
    discoveredAt: '2026-09-07T11:45:16.802Z',
    lastTransitionAt: '2026-09-07T11:45:16.802Z',
    backfilled: false,
    captureMethod: 'ambiguous_compat',
    captureAssessment: 'ambiguous',
    ...overrides,
  };
}

export function createFixture({
  sourceMessage = SOURCE_MESSAGE,
  authorization = AUTHORIZATION_MESSAGE,
  extraF299 = 0,
} = {}) {
  const taskStore = new TaskStore();
  const custodyTask = taskStore.create({
    threadId: 'thread-repair',
    title: 'repair list tasks',
    why: 'F313 D8',
    createdBy: OWNER_CAT_ID,
    ownerCatId: OWNER_CAT_ID,
    userId: OWNER_USER_ID,
    relatedFeatureId: 'F313',
  });
  taskStore.create({
    threadId: SOURCE_MESSAGE.threadId,
    title: 'F299 completion task',
    why: 'the source task must be discoverable',
    createdBy: OWNER_CAT_ID,
    ownerCatId: OWNER_CAT_ID,
    userId: OWNER_USER_ID,
    relatedFeatureId: 'F299',
  });
  taskStore.create({
    threadId: 'default',
    title: 'owner default-thread F299 task',
    why: 'same user remains visible in the shared thread',
    createdBy: OWNER_CAT_ID,
    ownerCatId: OWNER_CAT_ID,
    userId: OWNER_USER_ID,
    relatedFeatureId: 'F299',
  });
  taskStore.create({
    threadId: 'default',
    title: 'foreign default-thread F299 task',
    why: 'must not enter another user outcome',
    createdBy: 'user',
    ownerCatId: OWNER_CAT_ID,
    userId: 'other-user',
    relatedFeatureId: 'F299',
  });
  taskStore.create({
    threadId: 'default',
    title: 'ownerless default-thread F299 task',
    why: 'missing user ownership fails closed',
    createdBy: 'system',
    ownerCatId: OWNER_CAT_ID,
    relatedFeatureId: 'F299',
  });
  for (let index = 0; index < extraF299; index += 1) {
    taskStore.create({
      threadId: SOURCE_MESSAGE.threadId,
      title: `extra F299 task ${index}`,
      why: 'bounded query fixture',
      createdBy: OWNER_CAT_ID,
      ownerCatId: OWNER_CAT_ID,
      userId: OWNER_USER_ID,
      relatedFeatureId: 'F299',
    });
  }
  const messageStore = {
    async getById(messageId) {
      if (messageId === SOURCE_MESSAGE.id) return sourceMessage;
      if (messageId === AUTHORIZATION_MESSAGE.id) return authorization;
      return null;
    },
  };
  const threadStore = {
    async list(userId) {
      assert.equal(userId, OWNER_USER_ID);
      return [
        { id: 'default', createdBy: 'system' },
        { id: SOURCE_MESSAGE.threadId, createdBy: OWNER_USER_ID },
        { id: 'thread-repair', createdBy: OWNER_USER_ID },
      ];
    },
  };
  return { taskStore, custodyTask, messageStore, threadStore };
}

export function gitTruth({ loadedRevision = BASE_REVISION, mainRevision = BASE_REVISION, changedFiles = [] } = {}) {
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

export function provider(fixture, git = gitTruth()) {
  return new TaskWorkflowPawFeelDirectRepairOwnerProvider({
    messageStore: fixture.messageStore,
    taskStore: fixture.taskStore,
    threadStore: fixture.threadStore,
    ownerUserId: OWNER_USER_ID,
    gitTruth: git,
  });
}

export function sourceVerifier(messageStore) {
  return new PawFeelDirectRepairSourceVerifier({
    messageStore,
    classifyTool: defaultPawFeelSourceToolClassifier,
  });
}

export function providerSource() {
  return {
    sourceSignalRef: {
      ownerFeatureId: 'F278',
      ownerStateRef: `paw-feel-signal:${sourceCandidate.signalId}`,
      version: `${sourceCandidate.markerDigest}:0`,
    },
    sourceToolRef: { ownerFeatureId: 'F160', ownerStateRef: 'mcp-tool:cat_cafe_list_tasks' },
    markerDigest: sourceCandidate.markerDigest,
    sameDigestOrdinal: 0,
  };
}

export function providerCustody(fixture) {
  return {
    ownerCatId: OWNER_CAT_ID,
    taskId: fixture.custodyTask.id,
    leaseId: 'lease-1',
    leaseGeneration: 1,
    custodyEvidenceRef: 'action-lease:lease-1:generation:1',
  };
}

export async function resolveBinding(fixture) {
  const resolver = new PawFeelDirectRepairResolver({
    sourceVerifier: sourceVerifier(fixture.messageStore),
    federation: new PawFeelDirectRepairFederation([
      { route: TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE, provider: provider(fixture) },
    ]),
    custodyResolver: {
      async resolve() {
        return providerCustody(fixture);
      },
    },
    approvalContinuationResolver: {
      async resolve() {
        throw new Error('unexpected Approval fallback');
      },
    },
  });
  const result = await resolver.resolve({
    projection: sourceProjection(),
    leaseId: 'lease-1',
    actionRef: F160_LIST_TASKS_FEATURE_FILTER_REPAIR_ACTION,
  });
  assert.equal(result.status, 'authorized');
  return result.binding;
}
