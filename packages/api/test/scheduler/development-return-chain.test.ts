import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveGrowingSourceMessageRevision } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

function execution(f, freshSource = false) {
  let sourceRef = f.input.sourceActionRef;
  if (freshSource) {
    const task = f.tasks.get(f.input.taskId);
    const source = f.messages.append({
      userId: f.actor.userId,
      threadId: f.actor.threadId,
      catId: null,
      content: '继续已接受的 Phase B',
      mentions: [],
      timestamp: f.service.now() + 1,
    });
    sourceRef = `message:${source.id}`;
    const resumed = f.tasks.transitionDevelopmentWork({
      action: 'resume',
      actor: f.actor,
      taskId: task.id,
      scope: task.entrustedWork.developmentScope,
      expectedRevision: task.entrustedWork.revision,
      sourceRef,
      sourceRevision: deriveGrowingSourceMessageRevision(source),
      idempotencyKey: source.id,
    });
    assert.equal(resumed.result, 'resumed');
  }
  const proposal = f.proposals.create({
    sourceThreadId: f.actor.threadId,
    sourceCatId: f.actor.catId,
    sourceInvocationId: 'next',
    sourceMessageId: sourceRef.slice('message:'.length),
    title: 'Execution',
    reason: 'Accepted continuation',
    parentThreadId: f.actor.threadId,
    preferredCats: [f.actor.catId],
    projectPath: process.cwd(),
    createdBy: f.actor.userId,
    reportingMode: 'final-only',
  });
  const child = f.threads.create(f.actor.userId, 'Execution', process.cwd(), f.actor.threadId, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.actor.threadId,
    approvedBy: f.actor.userId,
    approvedAt: f.service.now(),
  });
  f.proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: f.actor.userId });
  f.proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  return {
    ...f.input,
    expectedRevision: f.tasks.get(f.input.taskId).entrustedWork.revision,
    executionThreadId: child.id,
    sourceActionRef: sourceRef,
    slaUntil: f.service.now() + 10000,
  };
}

test('the stable owner/Task admits only one return even for two approved children', async (t) => {
  const f = await fixture(t),
    next = execution(f);
  const results = await Promise.allSettled([
    f.service.register(f.actor, f.input, 'strict'),
    f.service.register(f.actor, next, 'strict'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.service.readForActor(f.actor).length, 1);
});

test('terminal history requires an explicit predecessor; successor may use new authorized source and execution', async (t) => {
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20000);
  await f.runner.triggerNow(first.registrationId);
  const nextInput = execution(f, true);
  await assert.rejects(f.service.register(f.actor, nextInput, 'strict'), /predecessor/i);
  const next = await f.service.register(
    f.actor,
    { ...nextInput, predecessorRegistrationId: first.registrationId },
    'strict',
  );
  assert.notEqual(next.executionThreadId, first.executionThreadId);
  assert.notEqual(next.sourceActionRef, first.sourceActionRef);
  assert.equal(next.taskRef, first.taskRef);
  const report = f.messages.append({
    userId: f.actor.userId,
    threadId: next.executionThreadId,
    catId: f.actor.catId,
    content: 'New accepted execution result',
    mentions: [],
    timestamp: f.service.now() + 1,
  });
  await f.service.report({ ...f.actor, threadId: next.executionThreadId }, next.registrationId, {
    sourceMessageId: report.id,
    outcome: 'completed',
    evidenceRefs: ['artifact:next'],
  });
  assert.equal(f.service.read(next.registrationId).status, 'delivered');
  assert.equal(f.wakes.length, 2, 'one signal per sequential registration, no duplicate carrier');
  const thirdInput = execution(f);
  await assert.rejects(
    f.service.register(f.actor, { ...thirdInput, predecessorRegistrationId: first.registrationId }, 'strict'),
    /predecessor|successor/i,
  );
  await f.service.register(f.actor, { ...thirdInput, predecessorRegistrationId: next.registrationId }, 'strict');
});

test('a terminal predecessor cannot fork two concurrent successor registrations', async (t) => {
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20000);
  await f.runner.triggerNow(first.registrationId);
  const results = await Promise.allSettled(
    [execution(f), execution(f)].map((input) =>
      f.service.register(f.actor, { ...input, predecessorRegistrationId: first.registrationId }, 'strict'),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.service.readForActor(f.actor).length, 2);
});

test('separate processes cannot commit two successors for the same owner/Task', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20000);
  await f.runner.triggerNow(first.registrationId);
  const directory = await mkdtemp(join(tmpdir(), 'f310-return-chain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'execution.sqlite');
  await f.db.backup(path);
  const workers = [1, 2].map((number) => {
    const state = {
      ...first,
      registrationId: `contender-${number}`,
      executionThreadId: `child-${number}`,
      predecessorRegistrationId: first.registrationId,
      status: 'waiting',
    };
    const definition = { ...f.definitions.getById(first.registrationId), id: state.registrationId, enabled: true };
    const child = fork(
      fileURLToPath(new URL('../helpers/development-return-race-worker.mjs', import.meta.url)),
      [path, JSON.stringify({ state, definition })],
      {
        execArgv: ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(stderr));
      });
    });
    const result = new Promise((resolve, reject) => {
      let received: unknown;
      child.on('message', (message) => {
        if (message !== 'ready') received = message;
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0 && received) resolve(received);
        else reject(new Error(stderr || 'Return contender exited without a result'));
      });
    });
    return { child, ready, result };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.send('start');
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.match(results.find((result) => !result.accepted).message, /predecessor|successor/i);
});
