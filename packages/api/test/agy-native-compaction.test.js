import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { AgyNativeProgress } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-progress.js';
import { resolveAuthoritativeCompactionSupport } from '../dist/domains/cats/services/session/context/authoritative-compaction.js';

const checkpoint = {
  kind: 'step',
  conversationId: 'native-one',
  stepIndex: 4,
  stepType: 'checkpoint',
  state: 'DONE',
  raw: {},
};
function fixture(t, { newError = false, checkpointState = 'DONE', rawStatus = 'SUCCESS', exitCode } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'native-compact-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const calls = [];
  const spawn = async function* (options) {
    calls.push(options);
    const compact = options.stdinInput.includes('/compact');
    yield {
      event: 'init',
      conversation_id: 'native-one',
      init: {
        cwd: options.cwd,
        agent: options.args[options.args.indexOf('--agent') + 1],
        model: 'gemini-3.8-flash-high',
        permission_mode: 'always-proceed',
      },
    };
    if (compact) {
      yield {
        event: 'step_update',
        step_update: { conversation_id: 'native-one', step_index: 2, state: 'DONE', step_type: 'user_input' },
      };
      yield {
        event: 'step_update',
        step_update: { conversation_id: 'native-one', step_index: 4, state: checkpointState, step_type: 'checkpoint' },
      };
      if (newError)
        yield {
          event: 'step_update',
          step_update: { conversation_id: 'native-one', step_index: 5, state: 'DONE', step_type: 'error_message' },
        };
    }
    yield {
      event: 'result',
      result: {
        conversation_id: 'native-one',
        status: compact ? rawStatus : 'SUCCESS',
        response: compact ? '' : 'hello',
        num_turns: compact ? 2 : 1,
        ...(rawStatus === 'ERROR' ? { error: 'retained prior error' } : {}),
      },
    };
    if (compact && exitCode)
      yield { __cliError: true, exitCode, signal: null, message: `CLI exited ${exitCode}`, command: 'agy' };
  };
  const config = {
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      autoApprove: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
    },
    l0CompilerFn: async () => '# Identity\nNative fixture.',
    spawnCliFn: spawn,
  };
  return { workspace, calls, config, spawn, service: new AgyNativeAgentService(config) };
}

for (const variant of [{ rawStatus: 'SUCCESS' }, { rawStatus: 'ERROR' }, { rawStatus: 'ERROR', exitCode: 3 }])
  test(`explicit native compaction accepts verified checkpoint evidence ${JSON.stringify(variant)}`, async (t) => {
    const f = fixture(t, variant);
    const first = [];
    for await (const msg of f.service.invoke('hello', { workingDirectory: f.workspace, spawnCliOverride: f.spawn }))
      first.push(msg);
    const binding = first.find((m) => m.type === 'session_init').nativeSessionBinding;
    // Reconstruct the service: the canonical binding, not a process-local session map, owns resume.
    const reconstructed = new AgyNativeAgentService(f.config);
    const event = await reconstructed.requestNativeCompaction({
      sessionId: binding.cliSessionId,
      nativeSessionBinding: binding,
      invocationId: 'compact-fixture',
      timeoutMs: 5000,
      userId: 'fixture-owner',
    });
    assert.equal(event.runtimeSessionId, binding.cliSessionId);
    assert.match(event.eventId, /native-one.*4/);
    assert.match(event.evidenceRef, /agy.*checkpoint/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--conversation') + 1], binding.cliSessionId);
    assert.equal(JSON.parse(f.calls[1].stdinInput).message.content[0].text, '/compact');
  });

for (const variant of [
  { newError: true },
  { checkpointState: 'ACTIVE' },
  { rawStatus: 'ERROR', exitCode: 1 },
  { rawStatus: 'ERROR', exitCode: 3, newError: true },
])
  test(`compaction refuses incomplete or failed current evidence ${JSON.stringify(variant)}`, async (t) => {
    const f = fixture(t, variant);
    const first = [];
    for await (const msg of f.service.invoke('hello', { workingDirectory: f.workspace, spawnCliOverride: f.spawn }))
      first.push(msg);
    const binding = first.find((m) => m.type === 'session_init').nativeSessionBinding;
    await assert.rejects(
      f.service.requestNativeCompaction({
        sessionId: binding.cliSessionId,
        nativeSessionBinding: binding,
        invocationId: 'compact-fixture',
        timeoutMs: 5000,
      }),
      /compaction.*failed/,
    );
  });

test('a checkpoint is routed once to its own carrier and cannot borrow Codex authority', () => {
  const progress = new AgyNativeProgress('gemini38', { provider: 'google', sessionId: 'native-one' });
  const messages = progress.step(checkpoint);
  assert.equal(messages.filter((m) => m.contextCompaction).length, 1);
  assert.equal(progress.step(checkpoint).length, 0);
  const eventSource = messages[0].contextCompaction.eventSource;
  assert.equal(
    resolveAuthoritativeCompactionSupport({
      eventSource,
      capability: { provider: 'google', carrier: 'agy_stream_json' },
    }).status,
    'supported',
  );
  assert.equal(
    resolveAuthoritativeCompactionSupport({ eventSource, capability: { provider: 'openai', carrier: 'app_server' } })
      .status,
    'unsupported',
  );
});

test('idle native control refuses a raced conversation lease instead of waiting and compacting a stale target', async (t) => {
  const f = fixture(t);
  const first = [];
  for await (const msg of f.service.invoke('hello', { workingDirectory: f.workspace, spawnCliOverride: f.spawn }))
    first.push(msg);
  const binding = first.find((m) => m.type === 'session_init').nativeSessionBinding;
  const { acquireAgyNativeProfileTurn } = await import(
    '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js'
  );
  const release = acquireAgyNativeProfileTurn(binding.profileHome, 'other-active-invocation', {
    conversationId: binding.cliSessionId,
  });
  try {
    await assert.rejects(
      f.service.requestNativeCompaction({
        sessionId: binding.cliSessionId,
        nativeSessionBinding: binding,
        invocationId: 'compact-fixture',
        timeoutMs: 100,
      }),
      /session_owner_unavailable/,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    release();
  }
});
