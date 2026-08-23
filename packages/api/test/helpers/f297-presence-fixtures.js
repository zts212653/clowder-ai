/**
 * F297 Phase B 测试夹具 —— 真实 production 组装，无 stub。
 *
 * 定性通道禁止 stub：PR #3748 前两轮的测试把 classifier stub 成固定返回，
 * 只证明了"候选能到达一个假定性器"，恰好绕开真正坏掉的一段。这里的每个 helper
 * 都返回真实 store / 真实 task / 真实 service。
 */

const DIST = '../../dist/';
export const load = (path) => import(DIST + path);

export async function realDeps() {
  const { InvocationTracker } = await load('domains/cats/services/agents/invocation/InvocationTracker.js');
  const { InvocationRecordStore } = await load('domains/cats/services/stores/ports/InvocationRecordStore.js');
  const { DraftStore } = await load('domains/cats/services/stores/ports/DraftStore.js');
  const { InMemoryTurnExecutionStore } = await load(
    'domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js',
  );
  return {
    invocationTracker: new InvocationTracker(),
    recordStore: new InvocationRecordStore(),
    draftStore: new DraftStore(),
    turnExecutionStore: new InMemoryTurnExecutionStore(),
    tasks: [],
  };
}

/** 用真实 service 组装真实 presence source —— 定性侧零 stub。 */
export async function realPresenceSource(deps, overrides = {}) {
  const { createActiveExecutionService } = await load(
    'domains/cats/services/agents/invocation/active-execution-service.js',
  );
  const { createSidebarPresenceSource } = await load(
    'domains/cats/services/agents/invocation/sidebar-presence-source.js',
  );
  const service = createActiveExecutionService({
    invocationTracker: deps.invocationTracker,
    recordStore: deps.recordStore,
    draftStore: deps.draftStore,
    turnExecutionStore: deps.turnExecutionStore,
    dynamicTaskStore: { getAll: () => deps.tasks },
    log: { info() {}, warn() {} },
    ...overrides.serviceDeps,
  });
  return {
    service,
    source: createSidebarPresenceSource({
      buildSnapshot: (userId) => service.buildSnapshot(userId),
      resolveWorkingPresence: (threadId, userId, snapshot) =>
        service.resolveWorkingPresence(threadId, userId, snapshot),
      listLatestTerminalExecutions: (threadIds, userId) =>
        deps.recordStore.listLatestTerminalByThreadIds(threadIds, userId),
      ...overrides.sourceDeps,
    }),
  };
}

/**
 * 一个 state=command_running 的 active managed wake task —— **真实 hold-ball 形状**。
 *
 * R5 P1-1 的教训：旧 fixture 缺 `templateId`、id 直接写 `t1`，等于把非 canonical shape
 * 固化成"合法"。投影侧一旦补上任务身份判别，这些 fixture 立刻暴露 —— 说明它们此前
 * 根本没在验证真实数据形状，只在验证我自己的假设。
 */
export function runningManagedCommandTask({ id, threadId, catId, userId, state = 'command_running' }) {
  return {
    id: `hold-ball-${id}`,
    templateId: 'reminder',
    enabled: true,
    deliveryThreadId: threadId,
    createdBy: `hold-ball:${catId}`,
    params: {
      triggerUserId: userId,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        createdBy: `hold-ball:${catId}`,
        managedCommand: { state, command: 'pnpm gate', startedAt: 1000 },
      },
    },
  };
}

export async function startRunningRecordWithDraft(deps, { threadId, userId, catId }) {
  const created = await deps.recordStore.create({
    threadId,
    userId,
    targetCats: [catId],
    intent: 'execute',
    idempotencyKey: `${threadId}:${catId}:${Math.random()}`,
    actionLeaseCarrier: { kind: 'none' },
  });
  // create() 落地是 `queued`；只有 running 才进 canonical liveness 与 running 索引。
  await deps.recordStore.update(created.invocationId, { status: 'running' });
  await deps.draftStore.upsert({
    userId,
    threadId,
    invocationId: created.invocationId,
    catId,
    content: 'thinking…',
    updatedAt: Date.now(),
  });
  return created.invocationId;
}
