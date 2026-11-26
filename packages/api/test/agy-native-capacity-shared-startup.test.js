import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { agyCapacityFixture } from './helpers/agy-capacity-fixture.js';

function fixture(t) {
  const f = agyCapacityFixture(t);
  const log = join(f.root, 'probes.jsonl');
  const first = join(f.root, 'first-probe');
  const gate = join(f.root, 'release-probe');
  writeFileSync(
    f.command,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '--version') process.exit(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid }) + '\\n');
let first = false;
try { fs.closeSync(fs.openSync(${JSON.stringify(first)}, 'wx')); first = true; } catch {}
if (first) {
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log('AGY CLI version 1.5.9'); }
  }, 10);
} else console.log('AGY CLI version 1.5.9');
`,
  );
  const credentialHome = join(f.root, 'account');
  const dir = join(credentialHome, '.gemini/antigravity-cli');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'antigravity-oauth-token'),
    JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'synthetic-shared-access',
        refresh_token: 'synthetic-shared-grant',
        expiry: '2099-01-01T00:00:00Z',
      },
    }),
    { mode: 0o600 },
  );
  const service = (catId, profileId) =>
    new AgyNativeAgentService({
      catId,
      command: f.command,
      profile: { enabled: true, autoApprove: true, profileId, homeRoot: join(f.root, 'profiles'), model: f.model },
      l0CompilerFn: async () => '# Identity\nShared-account capacity fixture.\n',
      rawArchive: { append: async () => {} },
    });
  return { ...f, log, gate, credentialHome, service };
}

async function started(log) {
  for (let i = 0; i < 500; i++) {
    if (existsSync(log)) {
      const record = readFileSync(log, 'utf8');
      const end = record.indexOf('\n');
      if (end >= 0) return JSON.parse(record.slice(0, end));
    }
    await delay(10);
  }
  assert.fail('first real version child did not start');
}

async function invoke(f, service, id, signal, observe = () => {}) {
  const messages = [];
  for await (const message of service.invoke('checkpoint', {
    workingDirectory: f.workspace,
    signal,
    invocationId: id,
    agyAccount: { storage: 'cli_file', credentialHome: f.credentialHome },
    livenessProbe: { sampleIntervalMs: 20, softWarningMs: 60, stallWarningMs: 120, stallAutoKill: false },
    spawnCliOverride: async function* (launch) {
      yield {
        event: 'init',
        conversation_id: id,
        init: {
          cwd: launch.cwd,
          agent: launch.args[launch.args.indexOf('--agent') + 1],
          model: f.model,
          permission_mode: 'always-proceed',
          tools: [],
        },
      };
      yield {
        event: 'step_update',
        step_update: {
          conversation_id: id,
          step_index: 1,
          step_type: 'checkpoint',
          state: 'DONE',
          usage: { input_tokens: 0, cache_read_tokens: 511499, output_tokens: 0 },
        },
      };
      yield { event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Done', num_turns: 1 } };
    },
  })) {
    messages.push(message);
    await observe(message);
  }
  return messages.at(-1);
}

for (const sameProfile of [false, true])
  test(`a pending version probe does not block a shared-account peer; sameProfile=${sameProfile}`, async (t) => {
    const f = fixture(t);
    const a = new AbortController(),
      b = new AbortController();
    const running = [];
    try {
      running.push(invoke(f, f.service('gemini-carbon', 'fixture'), 'pending-A', a.signal));
      await Promise.race([started(f.log), running[0].then((done) => assert.fail(JSON.stringify(done)))]);
      running.push(
        invoke(
          f,
          f.service(sameProfile ? 'gemini-carbon' : 'gemini-argon', sameProfile ? 'fixture' : 'peer'),
          'peer-B',
          b.signal,
        ),
      );
      const done = await Promise.race([running[1], delay(3000).then(() => undefined)]);
      assert.ok(done, 'peer B must complete while A version discovery is still gated');
      assert.equal(done.errorCode, undefined);
      assert.equal(done.metadata.contextWindowObservation?.windowTokens, 511499);
      assert.equal(existsSync(f.gate), false, 'A remains pending, not silently cancelled to let B start');
      assert.equal(a.signal.aborted, false);
    } finally {
      a.abort();
      b.abort();
      writeFileSync(f.gate, 'released');
      await Promise.allSettled(running);
    }
  });

test('pending capacity discovery emits a real liveness warning before cancellation and child release', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const messages = [];
  const pending = invoke(f, f.service('gemini-carbon', 'fixture'), 'pending-warning', controller.signal, (m) =>
    messages.push(m),
  );
  try {
    const { pid } = await Promise.race([started(f.log), pending.then((done) => assert.fail(JSON.stringify(done)))]);
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'system_info'); i++) await delay(10);
    const notice = messages.find((m) => m.type === 'system_info');
    assert.ok(notice, 'pending version discovery must be observable before spawnCli starts');
    const warning = JSON.parse(notice.content);
    assert.equal(warning.type, 'liveness_warning');
    assert.equal(warning.phase, 'capacity_version_discovery');
    assert.equal(warning.processAlive, true);
    assert.equal(
      messages.some((m) => m.type === 'session_init' || m.type === 'done'),
      false,
    );
    assert.equal(process.kill(pid, 0), true, 'warning alone must not terminate the pending version child');
    controller.abort();
    assert.equal((await pending).errorCode, 'AGY_CANCELLED');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await pending;
  }
});

test('closing the consumer at a discovery warning reaps its child and permits the next launch', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const disconnected = new Error('fixture consumer disconnected');
  const deadline = setTimeout(() => controller.abort(), 2000);
  let pid;
  try {
    await assert.rejects(
      invoke(f, f.service('gemini-carbon', 'fixture'), 'consumer-close', controller.signal, async (message) => {
        if (message.type === 'system_info') {
          ({ pid } = await started(f.log));
          throw disconnected;
        }
      }),
      (error) => error === disconnected,
    );
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const next = await invoke(f, f.service('gemini-carbon', 'fixture'), 'after-consumer-close', undefined);
    assert.equal(next.errorCode, undefined);
    assert.equal(next.metadata.contextWindowObservation?.windowTokens, 511499);
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
});
