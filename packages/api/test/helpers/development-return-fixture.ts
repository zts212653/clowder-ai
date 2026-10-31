import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import './setup-cat-registry.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProposalStore } from '../../src/domains/cats/services/stores/ports/ProposalStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { DevelopmentReturnService } from '../../src/infrastructure/scheduler/development-return/DevelopmentReturnService.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { createPersistedQueueFixture } from './persisted-queue-fixture.js';

export async function createDevelopmentReturnFixture(
  t: TestContext,
  options: {
    ownerCatId?: string;
    proposalDelegateCatId?: string;
    separateProposalSource?: boolean;
    catAuthoredProposalSource?: boolean;
    proposalTriggerCatId?: string;
    legacyReparentedChild?: boolean;
  } = {},
) {
  const ownerCatId = options.ownerCatId ?? 'codex-sol';
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const tasks = new TaskStore(),
    threads = new ThreadStore(),
    messages = new MessageStore(),
    proposals = new InMemoryProposalStore();
  const original = threads.create('human', 'Original', process.cwd());
  const actor = { userId: 'human', catId: ownerCatId, threadId: original.id };
  let now = Date.now();
  const source = messages.append({
    userId: 'human',
    from: { kind: 'user', userId: 'human' },
    threadId: original.id,
    content: '完成这个 B 子工作',
    mentions: [],
    timestamp: now,
  });
  const admitted = tasks.transitionDevelopmentWork({
    action: 'admit',
    actor,
    scope: {
      featureRef: 'feature:F310',
      phaseKey: 'B',
      workUnitRef: 'feature-phase:F310:B',
      acceptedSourceRef: 'file:docs/features/F310-growing.md',
      acceptedRevision: 'a'.repeat(40),
    },
    sourceRef: `message:${source.id}`,
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: 'admit',
    contract: {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${source.id}`],
        idempotencyKey: 'admit',
        receiptRef: 'task:receipt:first',
        admittedAt: now,
      },
      intendedOutcome: 'Development result',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'Verified result', expectedSignal: 'verified', evidenceRefs: [] },
    },
  });
  assert.ok('task' in admitted);
  const proposalSourceThread = options.separateProposalSource
    ? threads.create('human', 'Studio', process.cwd())
    : original;
  const proposalTriggerCatId = options.proposalTriggerCatId ?? ownerCatId;
  const peerTriggerSourceThread =
    options.catAuthoredProposalSource && proposalTriggerCatId !== ownerCatId
      ? threads.create('human', 'Peer trigger source', process.cwd())
      : null;
  const proposalSource = options.catAuthoredProposalSource
    ? messages.append({
        userId: 'human',
        from: proposalTriggerCatId ? { kind: 'agent', catId: proposalTriggerCatId } : { kind: 'user', userId: 'human' },
        threadId: proposalSourceThread.id,
        content: 'Route this accepted Task into an approved execution child',
        mentions: [],
        timestamp: now,
        ...(peerTriggerSourceThread
          ? {
              origin: 'callback' as const,
              extra: {
                crossPost: {
                  sourceThreadId: peerTriggerSourceThread.id,
                  sourceInvocationId: 'inv-peer-proposal-trigger',
                  effectClass: 'coordinate' as const,
                },
                targetCats: [ownerCatId],
              },
            }
          : {}),
      })
    : options.separateProposalSource
      ? messages.append({
          userId: 'human',
          from: { kind: 'user', userId: 'human' },
          threadId: proposalSourceThread.id,
          content: '把这个精确子工作拆到批准 child',
          mentions: [],
          timestamp: now,
        })
      : source;
  const proposalParentThread = options.legacyReparentedChild
    ? threads.create('human', 'Alternate parent', process.cwd())
    : original;
  const proposal = proposals.create({
    sourceThreadId: proposalSourceThread.id,
    sourceInvocationId: 'inv',
    sourceMessageId: proposalSource.id,
    sourceCatId: ownerCatId,
    title: 'Execution',
    reason: 'Authorized sub-work',
    parentThreadId: original.id,
    preferredCats: [options.proposalDelegateCatId ?? ownerCatId],
    projectPath: process.cwd(),
    createdBy: 'human',
    reportingMode: 'final-only',
    subjectTaskId: admitted.task.id,
    approvedDevelopmentScope: admitted.task.entrustedWork!.developmentScope,
  });
  const child = threads.create('human', 'Execution', process.cwd(), proposalParentThread.id, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: proposalSourceThread.id,
    approvedBy: 'human',
    approvedAt: now,
  });
  proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'human' });
  proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  const definitions = new DynamicTaskStore(db),
    events = [],
    wakes = [],
    deliveries = new Map(),
    admissions = [];
  let queueFull = false;
  const runner = new TaskRunnerV2({
    ledger: new RunLedger(db),
    dynamicTaskStore: definitions,
    logger: { info() {}, error() {} },
  });
  t.after(() => runner.stop());
  const transport = createPersistedQueueFixture(messages);
  t.after(() => transport.close());
  const delivery = {
    async deliver(input) {
      if (queueFull) throw new Error('Owner queue is full');
      const result = await transport.delivery.deliver(input);
      admissions.push({ input, result });
      if (result.message) {
        if (!deliveries.has(input.idempotencyKey))
          wakes.push([input.threadId, input.targetCatId, input.ownerUserId, input.content, result.message.id]);
        deliveries.set(input.idempotencyKey, result.message.id);
      }
      return result;
    },
  };
  const service = new DevelopmentReturnService({
    emit(...event) {
      events.push(event);
    },
    delivery,
    definitions,
    runner,
    tasks,
    threads,
    messages,
    proposals,
    now: () => now,
  });
  const input = {
    action: 'register',
    taskId: admitted.task.id,
    expectedRevision: 1,
    executionThreadId: child.id,
    sourceActionRef: `message:${options.catAuthoredProposalSource ? source.id : proposalSource.id}`,
    expectedSignal: 'terminal_report',
    slaUntil: now + 10000,
  };
  return {
    db,
    tasks,
    threads,
    messages,
    proposals,
    actor,
    source,
    child,
    proposalSource,
    proposalSourceThread,
    peerTriggerSourceThread,
    proposalParentThread,
    service,
    runner,
    definitions,
    events,
    wakes,
    deliveries,
    admissions,
    transport,
    input,
    setQueueFull(value) {
      queueFull = value;
    },
    tick(ms) {
      now += ms;
    },
    report() {
      return messages.append({
        userId: 'human',
        from: { kind: 'agent', catId: ownerCatId },
        threadId: child.id,
        content: 'Accepted development result and validation',
        mentions: [],
        timestamp: now + 1,
      });
    },
  };
}
