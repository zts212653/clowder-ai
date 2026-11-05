import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNativeAuthContinuation as run } from './helpers/native-auth-continuation-fixture.js';

test('Native confirmed-result 401 submits one new exact continuation and preserves the failed generation', async () => {
  const f = await run();
  assert.equal(f.calls, 2, JSON.stringify(f.messages.filter((m) => m.type === 'error')));
  assert.equal(f.launches.length, 2);
  assert.equal(f.factoryCalls, 1, 'recovery must not rebuild/reappend the original user prompt');
  assert.match(f.writes[0], /ORIGINAL_WORK/);
  assert.doesNotMatch(f.writes[1], /ORIGINAL_WORK/);
  assert.match(f.writes[1], /continu|继续/i);
  assert.equal(f.effects, 'A\nB\n');
  assert.ok(f.messages.some((m) => m.semanticEvent?.provenance?.nativeType === 'auth_continuation'));
  assert.equal(f.chain.length, 1);
  assert.equal(f.current.cliSessionId, 'same-native');
  assert.equal(f.messages.filter((m) => m.type === 'error').length, 0, JSON.stringify(f.messages));
  const generations = f.events.filter((e) => e.type === 'request_generation_assembled');
  assert.equal(generations.length, 2);
  assert.deepEqual(
    f.events.filter((e) => e.type === 'request_generation_terminal').map((e) => e.outcome),
    ['error', 'accepted'],
  );
  assert.ok(
    generations[1].envelope.channels.some((c) =>
      c.sourceRefs?.some((ref) => ref.owner === 'runtime_context' && ref.ref.includes('auth-continuation')),
    ),
  );
});

test('Native unknown tool result cannot be treated as completed by a synthetic error tool_result', async () => {
  const f = await run('unknown-result');
  assert.equal(f.calls, 1);
  assert.equal(f.effects, 'A\n');
  assert.ok(f.messages.some((m) => m.type === 'tool_result' && m.toolResultStatus === 'error'));
  assert.ok(f.messages.some((m) => m.type === 'error'));
});

test('Native auth recovery stops on binding drift without a cold replacement or a second submission', async () => {
  const f = await run('binding-drift');
  assert.equal(f.calls, 2);
  assert.equal(f.launches.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.chain.length, 1);
  assert.equal(f.current.status, 'active');
  assert.equal(f.effects, 'A\n');
  assert.ok(f.messages.some((m) => m.type === 'error' && m.errorCode === 'AGY_NATIVE_RESUME_MISMATCH'));
});

test('Native repeated auth failure remains a failure after the single continuation budget', async () => {
  const f = await run('auth-again');
  assert.equal(f.calls, 2);
  assert.equal(f.writes.length, 2);
  assert.equal(f.effects, 'A\n');
  assert.ok(f.messages.some((m) => m.type === 'error'));
  assert.deepEqual(
    f.events.filter((e) => e.type === 'request_generation_terminal').map((e) => e.outcome),
    ['error', 'error'],
  );
});

test('cancellation cannot trigger Native auth continuation', async () => {
  const f = await run('cancelled');
  assert.equal(f.calls, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.effects, 'A\n');
});

test('Native malformed terminal keeps its protocol failure and does not continue', async () => {
  const f = await run('malformed-terminal');
  assert.equal(f.calls, 1);
  assert.equal(f.writes.length, 1);
  assert.ok(
    f.messages.some((m) => m.type === 'error' && m.metadata?.diagnostics?.agyNative?.outcome === 'protocol_error'),
  );
});

test('a failed generation must be durable before Native recovery can launch', async () => {
  const f = await run('failure-record-unavailable');
  assert.equal(f.calls, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.effects, 'A\n');
  assert.ok(f.messages.some((m) => m.type === 'error' && m.error?.includes('fixture_transcript_unavailable')));
});

test('failed continuation persistence refuses its stdin and preserves the first failure', async () => {
  const f = await run('continuation-record-unavailable');
  assert.equal(f.calls, 2);
  assert.equal(f.launches.length, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(f.effects, 'A\n');
  assert.ok(f.messages.some((m) => m.type === 'error'));
  assert.deepEqual(
    f.events.filter((e) => e.type === 'request_generation_terminal').map((e) => e.outcome),
    ['error'],
  );
});

test('a broad auth classifier cannot turn a permission rejection into a continuation', async () => {
  const f = await run('permission-auth');
  assert.equal(f.calls, 1);
  assert.equal(f.writes.length, 1);
  assert.ok(f.messages.some((m) => m.type === 'error'));
});

test('auth continuation does not emit the original omitted memory receipt again', async () => {
  const f = await run('presentation');
  assert.equal(f.calls, 2);
  assert.equal(f.factoryCalls, 1);
  assert.equal(f.effects, 'A\nB\n');
  assert.equal(f.messages.filter((m) => m.content?.includes('omitted-before-auth')).length, 1);
});
