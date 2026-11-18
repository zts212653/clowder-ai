import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAgyCapacityScope } from '../dist/domains/cats/services/agents/providers/agy-native/run/agy-native-capacity-store.js';
import { agyCapacityFixture } from './helpers/agy-capacity-fixture.js';

function fixture(t, options = {}) {
  const f = agyCapacityFixture(t);
  const log = join(f.root, 'version-probes.jsonl');
  const mode = join(f.root, 'version-mode');
  const gate = join(f.root, 'version-release');
  writeFileSync(mode, options.mode ?? 'valid');
  mkdirSync(join(f.root, 'profiles/fixture/.gemini/config'), { recursive: true });
  writeFileSync(
    f.command,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '--version') process.exit(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid }) + '\\n');
function respond() {
  const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
  if (mode === 'failure') process.exit(7);
  console.log(mode === 'invalid' ? 'version unavailable' : 'AGY CLI version 1.5.9');
}
if (${Boolean(options.gated)}) {
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); respond(); }
  }, 10);
} else setTimeout(respond, ${options.delayMs ?? 0});
`,
  );
  const input = { command: f.command, profileHome: join(f.root, 'profiles/fixture'), model: f.model };
  return { ...f, log, mode, gate, input };
}

const probes = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

async function started(file, count = 1) {
  for (let i = 0; i < 500; i++) {
    if (probes(file).length >= count) return probes(file);
    await delay(10);
  }
  assert.fail('owned version probe did not start');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('slow version discovery keeps the event loop responsive for concurrent capacity consumers', async (t) => {
  const fixtures = Array.from({ length: 3 }, () => fixture(t, { delayMs: 2500 }));
  let heartbeats = 0;
  const heartbeat = setInterval(() => heartbeats++, 20);
  try {
    const scopes = await Promise.all(
      fixtures.map((f) => Promise.resolve().then(() => resolveAgyCapacityScope(f.input))),
    );
    assert.ok(heartbeats > 0, 'the shared API loop must advance while real version children are pending');
    for (const scope of scopes) assert.equal(scope?.cliVersion, '1.5.9');
  } finally {
    clearInterval(heartbeat);
  }
});

test('delayed version discovery preserves successful checkpoints and durable evidence for concurrent real services', async (t) => {
  const fixtures = Array.from({ length: 3 }, () => fixture(t, { delayMs: 2500 }));
  const first = await Promise.all(
    fixtures.map((f) => f.run(f.makeService(), { checkpoint: true, reasoningEffortOverride: 'low' })),
  );
  for (const done of first) {
    assert.equal(done.errorCode, undefined);
    assert.equal(done.metadata.contextWindowObservation?.windowTokens, 511499);
    assert.equal(done.metadata.contextWindowObservation?.model, 'gemini-4-carbon-low');
    assert.equal(done.metadata.contextWindowObservation?.cliVersion, '1.5.9');
  }
  const inherited = await Promise.all(fixtures.map((f) => f.run(f.makeService(), { reasoningEffortOverride: 'low' })));
  for (const done of inherited) assert.equal(done.metadata.contextWindowObservation?.windowTokens, 511499);
});

for (const mode of ['invalid', 'failure'])
  test(`a ${mode} version result can recover without changing the executable fingerprint`, async (t) => {
    const f = fixture(t, { mode });
    assert.equal(await resolveAgyCapacityScope(f.input), undefined);
    writeFileSync(f.mode, 'valid');
    const recovered = await resolveAgyCapacityScope(f.input);
    assert.equal(recovered?.cliVersion, '1.5.9');
    assert.equal((await resolveAgyCapacityScope(f.input))?.scopeId, recovered.scopeId);
    assert.equal(probes(f.log).length, 2, 'retry unknown results, then reuse the verified positive cache');
    f.setVersion('1.6.0');
    const replaced = await resolveAgyCapacityScope(f.input);
    assert.equal(replaced?.cliVersion, '1.6.0');
    assert.notEqual(replaced.scopeId, recovered.scopeId, 'executable replacement must invalidate the cache and scope');
  });

test('cancellation advances during version discovery and joins the owned child before returning', async (t) => {
  const f = fixture(t, { gated: true });
  const controller = new AbortController();
  const pending = Promise.resolve()
    .then(() => resolveAgyCapacityScope({ ...f.input, signal: controller.signal }))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    const [{ pid }] = await started(f.log);
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.error?.name, 'AbortError');
    assert.equal(alive(pid), false, 'cancellation is complete only when its real version child has stopped');
  } finally {
    controller.abort();
    await pending;
  }
});

test('the real service forwards cancellation to discovery and releases its launch ownership', async (t) => {
  const f = fixture(t, { gated: true });
  const controller = new AbortController();
  const pending = f.run(f.makeService(), { checkpoint: true, signal: controller.signal });
  try {
    const children = await started(f.log);
    controller.abort();
    assert.equal((await pending).errorCode, 'AGY_CANCELLED');
    for (const { pid } of children) assert.equal(alive(pid), false);
    writeFileSync(f.gate, 'released');
    const next = await f.run(f.makeService(), { checkpoint: true });
    assert.equal(next.errorCode, undefined);
    assert.equal(next.metadata.contextWindowObservation?.windowTokens, 511499);
  } finally {
    controller.abort();
    await pending;
  }
});

test('one cancelled version consumer cannot cancel another owner waiting for the same executable', async (t) => {
  const f = fixture(t, { gated: true });
  const cancelled = new AbortController();
  const survivor = new AbortController();
  const first = Promise.resolve()
    .then(() => resolveAgyCapacityScope({ ...f.input, signal: cancelled.signal }))
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const second = Promise.resolve().then(() => resolveAgyCapacityScope({ ...f.input, signal: survivor.signal }));
  try {
    await started(f.log, 2);
    cancelled.abort();
    assert.equal((await first).error?.name, 'AbortError');
    writeFileSync(f.gate, 'released');
    assert.equal((await second)?.cliVersion, '1.5.9');
  } finally {
    cancelled.abort();
    survivor.abort();
    await Promise.allSettled([first, second]);
  }
});

test('an executable changed during pending discovery cannot receive the old version scope', async (t) => {
  const f = fixture(t, { gated: true });
  const controller = new AbortController();
  const pending = Promise.resolve().then(() => resolveAgyCapacityScope({ ...f.input, signal: controller.signal }));
  try {
    await started(f.log);
    f.setVersion('1.6.0');
    writeFileSync(f.gate, 'released');
    assert.equal(await pending, undefined);
    assert.equal((await resolveAgyCapacityScope(f.input))?.cliVersion, '1.6.0');
  } finally {
    controller.abort();
    await Promise.allSettled([pending]);
  }
});
