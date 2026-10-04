import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import './setup-cat-registry.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProposalStore } from '../../src/domains/cats/services/stores/ports/ProposalStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { DevelopmentReturnService } from '../../src/infrastructure/scheduler/development-return/DevelopmentReturnService.js';
import { RunLedger } from '../../src/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.js';
import { createPersistedQueueFixture } from './persisted-queue-fixture.js';

export async function createDevelopmentReturnFixture(t: TestContext) {
  const db = new Database(':memory:');
  applyMigrations(db);
  t.after(() => db.close());
  const tasks = new TaskStore(),
    threads = new ThreadStore(),
    messages = new MessageStore(),
    proposals = new InMemoryProposalStore();
  const original = threads.create('human', 'Original', process.cwd());
  const actor = { userId: 'human', catId: 'codex-sol', threadId: original.id };
  let now = Date.now();
  const source = messages.append({
    userId: 'human',
    catId: null,
    threadId: original.id,
    content: '完成这个 B 子工作',
    mentions: [],
    timestamp: now,
  });
  const proposal = proposals.create({
    sourceThreadId: original.id,
    sourceInvocationId: 'inv',
    sourceMessageId: source.id,
    sourceCatId: 'codex-sol',
    title: 'Execution',
    reason: 'Authorized sub-work',
    parentThreadId: original.id,
    preferredCats: ['codex-sol'],
    projectPath: process.cwd(),
    createdBy: 'human',
    reportingMode: 'final-only',
  });
  const child = threads.create('human', 'Execution', process.cwd(), original.id, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: original.id,
    approvedBy: 'human',
    approvedAt: now,
  });
  proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'human' });
  proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
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
  const definitions = new DynamicTaskStore(db),
    events = [],
    wakes = [],
    deliveries = new Map();
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
    sourceActionRef: `message:${source.id}`,
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
    child,
    service,
    runner,
    definitions,
    events,
    wakes,
    deliveries,
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
        catId: 'codex-sol',
        threadId: child.id,
        content: 'Accepted development result and validation',
        mentions: [],
        timestamp: now + 1,
      });
    },
  };
}
