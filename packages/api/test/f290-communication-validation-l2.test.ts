/**
 * F290 communication — L2 validation: TWO Café Hosts against one Service, production Host components end to end.
 * See f290-communication-validation.host.ts for the exact production/fixture split. The model is a scripted Cat
 * (a `running` turn record calling the production CollectiveCurrentContext); no real model runs here, and no real
 * Human logged in. Regression expectations always run, without a todo bypass.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWorld,
  grantAndAdopt,
  postNaturalRequest,
  type World,
  workOf,
} from './f290-communication-validation.harness.js';
import { createHost, type Host, pumpUntil } from './f290-communication-validation.host.js';

async function withHosts(run: (world: World, operator: Host, wulang: Host) => Promise<void>) {
  const world = await createWorld();
  try {
    const operator = await createHost(world, world.operator);
    const wulang = await createHost(world, world.wulang);
    await run(world, operator, wulang);
  } finally {
    await world.close();
  }
}

test('two Cafés use production admission/return in both directions with scripted Cats and fixture Human acceptance', async () => {
  await withHosts(async (world, landyHost, wulangHost) => {
    const { operator, wulang } = world;
    await grantAndAdopt(world, operator);
    await grantAndAdopt(world, wulang);
    // Wulang asks You's Sol; You asks Wulang's Sol (same catId, different Cafés)
    const toYou = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Matter L: guide for You Café',
      landyHost.participationRevision,
    );
    const toWulang = await postNaturalRequest(
      world,
      operator,
      wulang,
      'codex-sol',
      'Matter W: guide for Wulang Café',
      wulangHost.participationRevision,
    );
    const works = () =>
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works;
    await pumpUntil(
      [landyHost, wulangHost],
      world,
      () => works().length === 2 && works().every((work) => work.lifecycle === 'result_ready'),
      'both matters reach result_ready',
    );
    for (const [host, request, other] of [
      [landyHost, toYou, wulangHost],
      [wulangHost, toWulang, landyHost],
    ] as const) {
      const work = works().find((candidate) => candidate.sourceEventId === request.eventId);
      assert.ok(work);
      assert.equal(work.accountableHumanId, host.cafe.humanId, 'accountable = the Café that owns the accepting Cat');
      assert.equal(work.acceptance?.hostAdmission?.state, 'admitted', 'the Service holds the Host admission fact');
      const tasks = await host.tasks.listByKind('work');
      assert.equal(tasks.length, 1, 'exactly one private Task per Café');
      assert.equal((await other.tasks.listByKind('work')).length, 1, 'the other Café has only its own Task');
      const source = tasks[0]?.entrustedWork?.admission.sourceRefs[0];
      assert.ok(source, 'the Task names its source');
      assert.ok(source.startsWith('message:'));
      const sourceMessageId = source.slice('message:'.length);
      const sourceMessage = await host.messages.getById(sourceMessageId);
      assert.equal(sourceMessage?.source?.meta?.workRequest, 'entrust');
      assert.deepEqual(
        host.runs.map((run) => run.scope),
        ['public', 'private'],
        'one public acceptance turn, then one admitted private run',
      );
      // Human acceptance of the current result closes the Host Task through the production reconciler
      await world.store.acceptCollectiveWorkResult(host.cafe.sessionToken, {
        ...world.coordinates,
        requestId: `accept-${work.workId}`,
        workId: work.workId,
        expectedRevision: work.revision,
        resultEventId: work.resultEventId,
        resultRevision: 1,
      });
      const completed = workOf(world, work.workId);
      const outcome = await host.resultReconciler.reconcile({
        ownerUserId: host.userId,
        sourceMessageId,
        work: completed,
      });
      assert.equal(outcome.result, 'closed');
    }
  });
});

const worksOf = (world: World) =>
  world.store.listCollectiveCollaboration(world.operator.sessionToken, world.coordinates.collectiveId).works;

/** A trigger shaped like the Host dispatcher's private-run carrier, to probe the execution gate directly. */
function probePrivateTrigger(host: Host, threadId: string, taskId: string, observedRevision: number) {
  return host.messages.append({
    userId: host.userId,
    threadId,
    catId: null,
    mentions: [],
    timestamp: Date.now(),
    content: 'probe: private Work run',
    extra: { collectiveWorkInvocationV1: { v: 1, taskId, observedRevision, resultRevision: 1, executionRevision: 1 } },
  });
}

test('scope withdrawn after the Service committed the Work but before any Host Task: refusal is recorded, nothing runs, nothing is born', async () => {
  await withHosts(async (world, landyHost) => {
    const { operator, wulang } = world;
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Matter R: guide',
      landyHost.participationRevision,
    );
    await landyHost.tick(); // request → the Cat accepts; the Service has committed the Work and its assignment
    const committed = worksOf(world).find((work) => work.sourceEventId === request.eventId);
    assert.ok(committed, 'the Service committed the Work');
    assert.equal(committed.acceptance?.hostAdmission, undefined);
    assert.equal((await landyHost.tasks.listByKind('work')).length, 0, 'no Host Task yet');

    await operator.connector.revokeWorkGrants(operator.connectionId, operator.ownerUserId, ['grant-guides']);
    await landyHost.tick(); // the assignment reaches Host admission, which must now refuse

    const after = workOf(world, committed.workId);
    assert.equal(after.acceptance?.hostAdmission?.state, 'rejected', 'the Host refusal is a recorded fact');
    assert.equal(after.lifecycle, 'committed', 'the public commitment is history, not erased');
    assert.equal((await landyHost.tasks.listByKind('work')).length, 0, 'no Task, no work Thread');
    assert.equal(landyHost.runs.filter((run) => run.scope === 'private').length, 0, 'no private execution');
    assert.equal(worksOf(world).length, 1);
    // and the execution gate itself refuses a carrier for work that was never admitted
    const thread = landyHost.endpoint.id;
    const trigger = probePrivateTrigger(landyHost, thread, 'task_never_admitted', 1);
    await assert.rejects(
      landyHost.context.resolvePrivate(
        {
          userId: landyHost.userId,
          threadId: thread,
          catId: 'codex-sol' as never,
          ownerAuthProvenance: 'unknown',
          originTriggerMessageId: trigger.id,
        },
        'admission',
      ),
      { code: 'OWNER_ADMISSION_UNAVAILABLE' },
    );
  });
});

test('crash after the Host Task exists but before the admission receipt reaches the Service: no execution, then exactly one run after recovery', async () => {
  await withHosts(async (world, landyHost) => {
    const { operator, wulang } = world;
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Matter C: guide',
      landyHost.participationRevision,
    );
    await landyHost.tick(); // the Cat accepts
    const committed = worksOf(world).find((work) => work.sourceEventId === request.eventId);
    assert.ok(committed);

    // The Service becomes unreachable right after the Host Task is created (a crash inside the admission sequence).
    landyHost.hooks.afterTaskAdmitted = async () => {
      landyHost.hooks.afterTaskAdmitted = undefined;
      await world.stopService();
    };
    await landyHost.tick().catch(() => undefined);
    const interrupted = (await operator.connector.listInbox(operator.connectionId)).filter((item) => item.routeFailure);
    assert.equal(interrupted.length, 1, 'the assignment routing really failed mid-admission (the fault was injected)');
    console.log(
      `# crash-before-receipt route failure: ${JSON.stringify(interrupted[0]?.routeFailure)} disposition=${interrupted[0]?.disposition}`,
    );
    const tasks = await landyHost.tasks.listByKind('work');
    assert.equal(tasks.length, 1, 'the Task exists');
    assert.equal(landyHost.runs.filter((run) => run.scope === 'private').length, 0, 'not executed before the receipt');

    await world.startService();
    // Before the receipt reaches the Service, the execution gate refuses (the Service Work has no admission fact).
    const task = tasks[0];
    assert.ok(task?.entrustedWork);
    const trigger = probePrivateTrigger(landyHost, task.threadId, task.id, task.entrustedWork.revision);
    await assert.rejects(
      landyHost.context.resolvePrivate(
        {
          userId: landyHost.userId,
          threadId: task.threadId,
          catId: 'codex-sol' as never,
          ownerAuthProvenance: 'unknown',
          originTriggerMessageId: trigger.id,
        },
        'admission',
      ),
      { code: 'OWNER_ADMISSION_UNAVAILABLE' },
    );
    assert.equal(workOf(world, committed.workId).acceptance?.hostAdmission, undefined);

    // Recovery: the durable Connector operation delivers the receipt; the Host retries the interrupted routing.
    await pumpUntil(
      [landyHost],
      world,
      () => workOf(world, committed.workId).lifecycle === 'result_ready',
      'the interrupted admission recovers and the Work returns its result',
    );
    const recovered = workOf(world, committed.workId);
    assert.equal(recovered.acceptance?.hostAdmission?.state, 'admitted');
    assert.equal((await landyHost.tasks.listByKind('work')).length, 1, 'still one Task');
    assert.equal(landyHost.runs.filter((run) => run.scope === 'private').length, 1, 'exactly one private execution');
    assert.equal(recovered.history.filter((entry) => entry.action === 'result_returned').length, 1, 'one result');
    assert.equal(worksOf(world).length, 1);
    // Control: with the receipt now on the Service, the very same gate opens. The earlier refusal was about the missing
    // receipt, not about the carrier shape or the provenance grade used by the probe.
    const [recoveredTask] = await landyHost.tasks.listByKind('work');
    assert.ok(recoveredTask?.entrustedWork);
    const reprobe = probePrivateTrigger(
      landyHost,
      recoveredTask.threadId,
      recoveredTask.id,
      recoveredTask.entrustedWork.revision,
    );
    assert.ok(
      await landyHost.context.resolvePrivate(
        {
          userId: landyHost.userId,
          threadId: recoveredTask.threadId,
          catId: 'codex-sol' as never,
          ownerAuthProvenance: 'unknown',
          originTriggerMessageId: reprobe.id,
        },
        'admission',
      ),
      'the execution gate opens once the Host admission receipt exists',
    );
  });
});

test('same Cat, two matters: A and B run on independent Threads/queues; a held A never blocks B, and each result returns to its own Work', async () => {
  await withHosts(async (world, landyHost) => {
    const { operator, wulang } = world;
    await grantAndAdopt(world, operator);
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    landyHost.hooks.holdPrivateRun = (task) =>
      task.entrustedWork?.intendedOutcome.includes('Matter A') ? gateA : undefined;
    const requestA = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Matter A: the guide',
      landyHost.participationRevision,
    );
    const requestB = await postNaturalRequest(
      world,
      operator,
      operator,
      'codex-sol',
      'Matter B: the FAQ',
      landyHost.participationRevision,
    );
    const byRequest = (eventId: string) => worksOf(world).find((work) => work.sourceEventId === eventId);
    await pumpUntil(
      [landyHost],
      world,
      () => byRequest(requestB.eventId)?.lifecycle === 'result_ready',
      'B returns while A is held',
    );
    const workA = byRequest(requestA.eventId);
    const workB = byRequest(requestB.eventId);
    assert.ok(workA && workB);
    assert.equal(workB.lifecycle, 'result_ready', 'B finished');
    assert.equal(workA.lifecycle, 'committed', 'A is still held, not failed and not blocking B');
    const taskA = await landyHost.taskFor('Matter A');
    const taskB = await landyHost.taskFor('Matter B');
    assert.ok(taskA && taskB);
    assert.notEqual(taskA.threadId, taskB.threadId, 'independent execution Threads');
    assert.equal(landyHost.runs.filter((run) => run.scope === 'private').length, 2, 'both private runs started');

    releaseA();
    await pumpUntil(
      [landyHost],
      world,
      () => byRequest(requestA.eventId)?.lifecycle === 'result_ready',
      'A returns once released',
    );
    const finalA = byRequest(requestA.eventId);
    const finalB = byRequest(requestB.eventId);
    assert.notEqual(finalA?.resultEventId, finalB?.resultEventId, 'each Work has its own result');
    assert.equal(finalB?.resultEventId, workB.resultEventId, 'B’s result was not touched by A');
    assert.equal(worksOf(world).length, 2);
  });
});

test('a transient Service fault that is not ECONNREFUSED, after the Host Task exists, does not strand the accepted Work', async () => {
  await withHosts(async (world, landyHost) => {
    const { operator, wulang } = world;
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Matter T: guide',
      landyHost.participationRevision,
    );
    await landyHost.tick(); // the Cat accepts
    const committed = worksOf(world).find((work) => work.sourceEventId === request.eventId);
    assert.ok(committed);
    // The Service records the Host admission, but its response never reaches the Host (a reset / opaque failure).
    world.injectFault({ path: '/api/collaboration/work/host-admission', when: 'after' });
    await landyHost.tick();
    let failure: string | undefined;
    const outcome = await pumpUntil(
      [landyHost],
      world,
      () => workOf(world, committed.workId).lifecycle === 'result_ready',
      'the accepted Work recovers after a transient fault',
      6,
    ).then(
      () => undefined,
      (error: Error) => {
        const stuck = operator.connector.listInbox(operator.connectionId);
        failure = error.message;
        return stuck;
      },
    );
    const stuckItems = outcome ? (await outcome).filter((item) => item.routeFailure) : [];
    assert.equal(
      failure,
      undefined,
      `stranded: ${JSON.stringify(stuckItems.map((item) => ({ disposition: item.disposition, failure: item.routeFailure })))}; ` +
        `Task=${(await landyHost.tasks.listByKind('work')).length}, ` +
        `Service receipt=${workOf(world, committed.workId).acceptance?.hostAdmission?.state}, ` +
        `private runs=${landyHost.runs.filter((run) => run.scope === 'private').length}`,
    );
  });
});

test('feedback on an accepted natural Work resumes the same Host Task and Thread; v2 returns to the same Work and only the current result closes the Task', async () => {
  await withHosts(async (world, landyHost) => {
    const { operator, wulang } = world;
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Matter F: guide',
      landyHost.participationRevision,
    );
    const current = () => worksOf(world).find((work) => work.sourceEventId === request.eventId);
    await pumpUntil([landyHost], world, () => current()?.lifecycle === 'result_ready', 'v1 returned');
    const v1 = current();
    assert.ok(v1);
    const [task] = await landyHost.tasks.listByKind('work');
    assert.ok(task);

    await world.store.requestCollectiveWorkRevision(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'feedback-1',
      workId: v1.workId,
      expectedRevision: v1.revision,
      resultEventId: v1.resultEventId,
      resultRevision: 1,
      feedback: 'Shorter, please.',
    });
    await pumpUntil(
      [landyHost],
      world,
      () => current()?.lifecycle === 'result_ready' && current()?.resultRevision === 2,
      'v2 returned on the same Work',
    );
    const v2 = current();
    assert.ok(v2);
    assert.equal(v2.workId, v1.workId, 'the same Work, not a new one');
    assert.notEqual(v2.resultEventId, v1.resultEventId);
    const tasks = await landyHost.tasks.listByKind('work');
    assert.equal(tasks.length, 1, 'no second Task');
    assert.equal(tasks[0]?.id, task.id);
    const privateRuns = landyHost.runs.filter((run) => run.scope === 'private');
    assert.deepEqual(
      privateRuns.map((run) => [run.taskId, run.threadId, run.resultRevision]),
      [
        [task.id, task.threadId, 1],
        [task.id, task.threadId, 2],
      ],
      'two rounds of the same admitted Task on the same Thread',
    );

    const sourceRef = tasks[0]?.entrustedWork?.admission.sourceRefs[0];
    assert.ok(sourceRef);
    await world.store.acceptCollectiveWorkResult(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'accept-v2',
      workId: v2.workId,
      expectedRevision: v2.revision,
      resultEventId: v2.resultEventId,
      resultRevision: 2,
    });
    const outcome = await landyHost.resultReconciler.reconcile({
      ownerUserId: landyHost.userId,
      sourceMessageId: sourceRef.slice('message:'.length),
      work: workOf(world, v2.workId),
    });
    assert.equal(outcome.result, 'closed');
    const evidence = (await landyHost.tasks.get(task.id))?.entrustedWork?.closure.evidenceRefs ?? [];
    assert.ok(
      evidence.some((ref) => ref.includes(v2.resultEventId as string)) &&
        !evidence.some((ref) => ref.includes(v1.resultEventId as string)),
      'closure cites the current result, not v1',
    );
  });
});
