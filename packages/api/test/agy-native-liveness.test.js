import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'f325-native-liveness-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: { enabled: true, autoApprove: true, model: 'gemini-3.8-flash-high', homeRoot: join(root, 'profiles') },
    l0CompilerFn: async () => '# Identity\nFixture cat.',
  });
  return { service, workspace };
}

function init(launch) {
  return {
    event: 'init',
    conversation_id: 'liveness-session',
    init: {
      cwd: launch.cwd,
      agent: launch.args[launch.args.indexOf('--agent') + 1],
      model: 'gemini-3.8-flash-high',
      permission_mode: 'always-proceed',
    },
  };
}

function toolStep(state) {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: 'liveness-session',
      step_index: 1,
      step_type: 'tool',
      tool_name: 'run_command',
      state,
    },
  };
}

const complete = {
  event: 'result',
  result: { conversation_id: 'liveness-session', status: 'SUCCESS', response: 'done' },
};
const warning = {
  __livenessWarning: true,
  state: 'idle-silent',
  level: 'suspected_stall',
  silenceDurationMs: 300_000,
  processAlive: true,
  cpuTimeMs: 10,
  firstEventAt: 1_000,
  lastEventAt: 2_000,
  lastEventType: 'step_update',
};

test('Native passes the caller warning-only probe settings to the actual launch', async (t) => {
  const f = fixture(t);
  const configured = { stallAutoKill: false, sampleIntervalMs: 10, softWarningMs: 20, stallWarningMs: 30 };
  let received;
  const messages = [];
  for await (const message of f.service.invoke('work', {
    workingDirectory: f.workspace,
    livenessProbe: configured,
    spawnCliOverride: async function* (launch) {
      received = launch.livenessProbe;
      yield init(launch);
      yield complete;
    },
  }))
    messages.push(message);
  assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
  assert.deepEqual(received, configured);
});

for (const level of ['alive_but_silent', 'suspected_stall']) {
  test(`Native streams ${level} before completion and continues the same run`, async (t) => {
    const f = fixture(t);
    const messages = [];
    let observedBeforeTerminal = false;
    for await (const message of f.service.invoke('work', {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        yield init(launch);
        yield { ...warning, level };
        observedBeforeTerminal = messages.some((m) => m.type === 'system_info');
        yield complete;
      },
    }))
      messages.push(message);
    assert.equal(observedBeforeTerminal, true, 'the warning must reach the consumer before provider completion');
    const notices = messages.filter((m) => m.type === 'system_info');
    assert.equal(notices.length, 1);
    assert.deepEqual(JSON.parse(notices[0].content), { type: 'liveness_warning', ...warning, level });
    assert.equal(notices[0].catId, 'gemini38');
    assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
    assert.equal(messages.filter((m) => m.type === 'done').length, 1);
    assert.ok(messages.some((m) => m.type === 'text' && m.content === 'done'));
  });
}

test('a pre-init liveness warning is visible but cannot certify a Native session or success', async (t) => {
  const f = fixture(t);
  const messages = [];
  for await (const message of f.service.invoke('work', {
    workingDirectory: f.workspace,
    spawnCliOverride: async function* () {
      yield warning;
    },
  }))
    messages.push(message);
  assert.ok(messages.some((m) => m.type === 'system_info'));
  assert.equal(
    messages.some((m) => m.type === 'session_init' || m.type === 'text'),
    false,
  );
  assert.equal(messages.filter((m) => m.type === 'done').length, 1);
  assert.ok(messages.at(-1).errorCode, 'a warning is not verified init or a successful terminal');
});

test('Native liveness names the last observed tool and preserves its first observation across repeated updates', async (t) => {
  const f = fixture(t);
  const messages = [];
  const untypedWarning = { ...warning, lastEventType: null };
  for await (const message of f.service.invoke('work', {
    workingDirectory: f.workspace,
    spawnCliOverride: async function* (launch) {
      yield init(launch);
      yield toolStep('ACTIVE');
      yield untypedWarning;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      yield toolStep('ACTIVE');
      yield untypedWarning;
      yield toolStep('DONE');
      yield complete;
    },
  }))
    messages.push(message);
  const notices = messages.filter((m) => m.type === 'system_info').map((m) => JSON.parse(m.content));
  assert.equal(notices.length, 2);
  assert.equal(notices[0].lastEventType, 'step_update');
  assert.equal(notices[0].lastNativeStep.stepIndex, 1);
  assert.equal(notices[0].lastNativeStep.toolName, 'run_command');
  assert.equal(notices[0].lastNativeStep.state, 'ACTIVE');
  assert.ok(notices[0].lastNativeStep.firstObservedAt > 0);
  assert.equal(notices[1].lastNativeStep.toolName, 'run_command');
  assert.equal(notices[1].lastNativeStep.stepType, 'tool');
  assert.equal(notices[1].lastNativeStep.firstObservedAt, notices[0].lastNativeStep.firstObservedAt);
  assert.equal(untypedWarning.lastEventType, null, 'enrichment must not mutate the upstream warning');
  assert.equal(messages.at(-1).errorCode, undefined, JSON.stringify(messages));
  assert.equal(messages.filter((m) => m.type === 'done').length, 1);
});

for (const trailingEvent of [complete, { event: 'future_observation' }]) {
  test(`Native retains step context without inventing the last event after ${trailingEvent.event}`, async (t) => {
    const f = fixture(t);
    const messages = [];
    const untypedWarning = { ...warning, lastEventType: null };
    for await (const message of f.service.invoke('work', {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        yield init(launch);
        yield toolStep('DONE');
        yield trailingEvent;
        yield untypedWarning;
        if (trailingEvent.event !== 'result') yield complete;
      },
    }))
      messages.push(message);
    const notices = messages.filter((m) => m.type === 'system_info').map((m) => JSON.parse(m.content));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].lastEventType, null, 'an earlier step must not overwrite the unknown final event type');
    assert.equal(notices[0].lastNativeStep.toolName, 'run_command');
    assert.equal(notices[0].lastNativeStep.state, 'DONE');
    assert.equal(untypedWarning.lastEventType, null);
    assert.equal(
      messages.at(-1).errorCode,
      trailingEvent.event === 'result' ? undefined : 'AGY_NATIVE_FAILED',
      'an unknown native event must retain the existing protocol failure',
    );
    assert.equal(messages.filter((m) => m.type === 'done').length, 1);
  });
}
