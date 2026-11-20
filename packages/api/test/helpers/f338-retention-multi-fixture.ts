import type { TestContext } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { base, retentionCoordinatorFixture } from './f338-retention-coordinator-fixture.js';

export async function multiRetentionFixture(t: TestContext) {
  const f = await retentionCoordinatorFixture(t, { admitSource: false });
  const contexts = [];
  for (let i = 0; i < 3; i++) {
    const record = structuredClone(f.record),
      source = structuredClone(f.source),
      response = structuredClone(f.response);
    record.id = `parent-${i}`;
    record.threadId = `home-${i}`;
    record.cliSessionId = `native-${i}`;
    record.catId = createCatId(i === 2 ? 'fable-5' : 'opus55');
    const observation = record.lastUsage!.cacheObservation!;
    observation.invocationId = `source-${i}`;
    observation.nativeSessionId = record.cliSessionId;
    observation.model = i === 2 ? 'claude-fable-5-2' : 'claude-opus-5-5';
    source.id = `dispatch-${i}`;
    source.catId = record.catId;
    source.from = { kind: 'agent', catId: record.catId };
    source.extra = { crossPost: { sourceThreadId: record.threadId, sourceInvocationId: observation.invocationId } };
    source.lifecycle = {
      kind: 'input',
      orderKey: source.id,
      dispatchRefs: [{ targetId: 'worker', phase: 'dispatched', statusMessageId: `reply-${i}` }],
    };
    response.id = `reply-${i}`;
    response.lifecycle = {
      kind: 'response',
      status: 'processing',
      targetId: 'worker',
      inputMessageIds: [source.id],
      orderKey: response.id,
    };
    f.records.set(record.threadId, record);
    f.history.set(source.id, source);
    f.history.set(response.id, response);
    await f.executions.createRunning({
      invocationId: observation.invocationId,
      parentInvocationId: observation.invocationId,
      userId: 'owner',
      threadId: record.threadId,
      catId: record.catId,
      executionKind: 'ordinary',
      providerLifecycleTracked: true,
      startedAt: base,
    });
    await f.executions.markProviderStarted(observation.invocationId, base);
    await f.executions.recordProviderTeardown(observation.invocationId, base + 1000);
    await f.executions.transitionTerminal(observation.invocationId, {
      status: 'succeeded',
      endedAt: base + 1000,
      terminalReason: 'fixture',
    });
    await f.coordinator.observeDispatch(source, ['worker']);
    contexts.push({ record, source, response });
  }
  await f.enable();
  await f.settings.set('owner', 'fable-5', true);
  f.time(49);
  await f.coordinator.tick();
  return { ...f, contexts };
}
