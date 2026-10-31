import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCodexAppServerNotification } from '../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.js';
import { transformCodexEvent } from '../src/domains/cats/services/agents/providers/codex-event-transform.js';
import { projectInvocationTrajectories } from '../src/domains/cats/services/session/InvocationTrajectoryProjector.js';
import { InvocationSummaryAccumulator } from '../src/domains/cats/services/session/transcript-index/InvocationSummaryAccumulator.js';
import { compactTranscriptEvent } from '../src/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';

const session = { id: 'session', threadId: 'thread', catId: 'codex-sol', seq: 0, status: 'active' } as const;
const identity = { provider: 'codex', runtimeSessionId: 'native-session', turnId: 'turn', nativeId: 'first' };
const output = (
  content: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> & { outputMessage: Record<string, unknown> } => ({
  type: 'text',
  content,
  textMode: 'append',
  outputMessage: { ...identity, channel: 'commentary', complete: false, ...patch },
});
const envelope = (event: Record<string, unknown>, eventNo: number) => ({
  v: 1 as const,
  t: 1000 + eventNo,
  threadId: 'thread',
  catId: 'codex-sol',
  sessionId: 'session',
  invocationId: 'inv',
  eventNo,
  event,
});
function project(payloads: Record<string, unknown>[]) {
  return projectInvocationTrajectories(payloads.map(envelope), session)[0].firstAssistantOutputEvidence;
}

test('native mapper → transform preserves separate message/channel/completion without stored messageId', () => {
  const state = { hadPriorTextTurn: false };
  const messages = ['You，', '我查完了。'].map((text, index) => {
    const native = mapCodexAppServerNotification({
      method: 'item/completed',
      params: {
        threadId: identity.runtimeSessionId,
        turnId: identity.turnId,
        item: {
          type: 'agentMessage',
          id: index ? 'second' : 'first',
          phase: index ? 'final_answer' : 'commentary',
          text,
        },
      },
    });
    assert.ok(native);
    return transformCodexEvent(native, 'codex-sol', state);
  });
  assert.deepEqual(messages[0]?.outputMessage, {
    ...identity,
    channel: 'commentary',
    complete: true,
    textMode: 'replace',
  });
  assert.equal(messages[0]?.messageId, undefined);
  assert.equal(messages[0]?.textMode, undefined);
  assert.equal(messages[1]?.content, '\n\n我查完了。');
  assert.equal(messages[1]?.outputMessage?.channel, 'final');
  assert.equal(messages[1]?.outputMessage?.displayPrefixLength, 2);
  const first = project(messages as Record<string, unknown>[]);
  assert.equal(first?.status, 'available');
  assert.equal(first?.content, 'You，');
  assert.equal(first?.identity.nativeId, 'first');
});

test('same identity/channel appends then replaces with complete snapshot, without 140-char truncation', () => {
  const full = '完整首条猫消息。'.repeat(30);
  const payloads = [
    output('错误前缀'),
    output('错误后缀'),
    { ...output(full, { complete: true }), textMode: 'replace' },
  ];
  const evidence = project(payloads);
  assert.equal(evidence?.status, 'available');
  assert.equal(evidence?.content, full);
  assert.deepEqual(evidence?.source, {
    sessionId: 'session',
    invocationId: 'inv',
    firstEventNo: 0,
    lastEventNo: 2,
    eventCount: 3,
  });
  const accumulator = new InvocationSummaryAccumulator(session);
  for (const event of payloads.map(envelope)) accumulator.add(compactTranscriptEvent(event).projection);
  assert.deepEqual([...accumulator.values()][0].firstAssistantOutputEvidence, evidence);
});

test('the earliest legacy candidate stays fixed even when a later final is fully evidenced', () => {
  const evidence = project([
    { type: 'text', content: 'You，' },
    output('later final', { nativeId: 'second', channel: 'final', complete: true }),
  ]);
  assert.equal(evidence?.status, 'unknown_identity');
  assert.equal(evidence?.source.firstEventNo, 0);
  assert.equal(evidence?.content, undefined);
  assert.equal(project([{ type: 'user', content: 'question' }, { type: 'status' }]), undefined);
});

for (const field of ['provider', 'runtimeSessionId', 'turnId', 'nativeId']) {
  for (const value of ['', ' ', ' first']) {
    test(`invalid ${field}=${JSON.stringify(value)} never becomes identity by trimming`, () => {
      assert.equal(
        project([
          output('early', { [field]: value, complete: true }),
          output('later', { nativeId: 'second', complete: true }),
        ])?.status,
        'unknown_identity',
      );
    });
  }
}
test('missing turn and unknown channel are honestly unavailable', () => {
  assert.equal(project([output('a', { turnId: undefined, complete: true })])?.status, 'unknown_identity');
  assert.equal(project([output('a', { channel: undefined, complete: true })])?.status, 'unknown_channel');
});
test('different identity cannot finish an earlier incomplete message', () => {
  const evidence = project([output('You，'), output('我查完了。', { nativeId: 'second', complete: true })]);
  assert.equal(evidence?.status, 'incomplete');
  assert.equal(evidence?.content, undefined);
  assert.equal(evidence?.source.lastEventNo, 0);
});
test('same native identity across channels is a conflict, including after completion', () => {
  for (const complete of [false, true]) {
    const evidence = project([
      output('You，', { complete }),
      output('我查完了。', { channel: 'final', complete: true }),
    ]);
    assert.equal(evidence?.status, 'conflict');
    assert.equal(evidence?.content, undefined);
  }
});
for (const boundary of [
  'tool_use',
  'tool_result',
  'error',
  'done',
  'user',
  'system',
  'turn.started',
  'turn.completed',
]) {
  test(`${boundary} separates messages rather than completing an earlier fragment`, () => {
    const evidence = project([output('You，'), { type: boundary }, output('我查完了。', { complete: true })]);
    assert.equal(evidence?.status, 'conflict');
    assert.equal(evidence?.content, undefined);
  });
}
test('different native turn is a different message even when nativeId is reused', () => {
  assert.equal(
    project([output('early'), output('later', { turnId: 'new-turn', complete: true })])?.status,
    'incomplete',
  );
});
test('oversized single/multiple events are never advertised as complete or truncated content', () => {
  for (const payloads of [
    [output('猫'.repeat(3000), { complete: true })],
    [output('x'.repeat(3000)), output('y'.repeat(3000), { complete: true })],
  ]) {
    const evidence = project(payloads);
    assert.equal(evidence?.status, 'oversized');
    assert.equal(evidence?.content, undefined);
    assert.ok(evidence);
    assert.ok(evidence.byteLength > 4096);
    const accumulator = new InvocationSummaryAccumulator(session);
    for (const event of payloads.map(envelope)) accumulator.add(compactTranscriptEvent(event).projection);
    assert.deepEqual([...accumulator.values()][0].firstAssistantOutputEvidence, evidence);
    assert.ok(JSON.stringify([...accumulator.values()]).length < 2000);
  }
});
test('a replace snapshot can restore a previously oversized incomplete candidate', () => {
  assert.equal(
    project([output('x'.repeat(6000)), { ...output('corrected', { complete: true }), textMode: 'replace' }])?.content,
    'corrected',
  );
});
test('explicit user/system role on text never becomes an assistant in the compact index', () => {
  const payloads = [{ type: 'text', role: 'user', content: 'question' }, output('real first', { complete: true })];
  const accumulator = new InvocationSummaryAccumulator(session);
  for (const event of payloads.map(envelope)) accumulator.add(compactTranscriptEvent(event).projection);
  assert.deepEqual([...accumulator.values()][0].firstAssistantOutputEvidence, project(payloads));
  assert.equal(project(payloads)?.content, 'real first');
});
test('UTF-8 byte length belongs to the assembled native message, including split surrogate pairs', () => {
  const payloads = [output('\ud83d'), output('\ude00', { complete: true })];
  const evidence = project(payloads);
  assert.equal(evidence?.content, '😀');
  assert.equal(evidence?.byteLength, 4);
  const accumulator = new InvocationSummaryAccumulator(session);
  for (const event of payloads.map(envelope)) accumulator.add(compactTranscriptEvent(event).projection);
  assert.deepEqual([...accumulator.values()][0].firstAssistantOutputEvidence, evidence);
});
test('explicit invalid native/legacy modes cannot publish a fabricated available snapshot', () => {
  const invalid = ['bogus', 'APPEND', '', ' append', null, true, 0, {}, []];
  for (const value of invalid) {
    for (const nested of [true, false]) {
      const second = output('full snapshot', { complete: true });
      if (nested) second.outputMessage.textMode = value;
      else second.textMode = value;
      const payloads = [output('prefix'), second];
      const evidence = project(payloads);
      assert.equal(evidence?.status, 'conflict', `nested=${nested} mode=${String(value)}`);
      assert.equal(evidence?.content, undefined);
      const accumulator = new InvocationSummaryAccumulator(session);
      for (const event of payloads.map(envelope)) accumulator.add(compactTranscriptEvent(event).projection);
      assert.deepEqual([...accumulator.values()][0].firstAssistantOutputEvidence, evidence);
      assert.equal(project([second])?.status, 'conflict');
      assert.deepEqual(project(JSON.parse(JSON.stringify(payloads))), evidence);
    }
  }
});
test('own undefined modes follow canonical JSON omission in direct and compact/index projections', () => {
  for (const nested of [undefined, 'append', 'replace']) {
    for (const outer of [undefined, 'append', 'replace', null, 'bogus']) {
      const second = { ...output('full snapshot', { complete: true, textMode: nested }), textMode: outer };
      const payloads = [output('prefix', { textMode: 'append' }), second];
      const evidence = project(payloads);
      const persisted = JSON.parse(JSON.stringify(payloads));
      assert.deepEqual(evidence, project(persisted), `native=${nested} outer=${String(outer)}`);
      for (const events of [payloads, persisted]) {
        const accumulator = new InvocationSummaryAccumulator(session);
        for (const event of events.map(envelope)) accumulator.add(compactTranscriptEvent(event).projection);
        assert.deepEqual([...accumulator.values()][0].firstAssistantOutputEvidence, evidence);
      }
    }
  }
});
test('only genuinely absent native mode falls back to valid outer mode or the original append default', () => {
  const second = output('full snapshot', { complete: true });
  delete second.textMode;
  assert.equal(project([output('prefix'), second])?.content, 'prefixfull snapshot');
  second.textMode = 'replace';
  assert.equal(project([output('prefix'), second])?.content, 'full snapshot');
  second.outputMessage.textMode = 'append';
  second.textMode = 'bogus';
  assert.equal(project([output('prefix'), second])?.content, 'prefixfull snapshot');
  second.outputMessage.textMode = null;
  second.textMode = 'replace';
  assert.equal(project([output('prefix'), second])?.status, 'conflict');
});
