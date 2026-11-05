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
