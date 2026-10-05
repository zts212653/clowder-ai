import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { NodeExternalPluginProcessAdapter } from '../dist/domains/plugin/external-runtime/index.js';

const posixOnly = { skip: process.platform === 'win32', timeout: 5_000 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readyLine(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk.toString();
    if (text.includes('\n')) return text.split('\n')[0];
  }
  throw new Error('fixture closed before readiness');
}

async function ownedProcess(code, graceMs = 40) {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-owned-group-'));
  const adapter = new NodeExternalPluginProcessAdapter(graceMs);
  const child = await adapter.spawn({ command: process.execPath, args: ['-e', code], cwd: root, env: {} });
  const rawKill = process.kill.bind(process);
  return {
    child,
    async cleanup() {
      try {
        rawKill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('termination waits for the owned group after its root exits and descendants ignore TERM', posixOnly, async () => {
  const descendant =
    "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),4000);";
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>process.stdout.write(String(c.pid)+'\\n',()=>process.exit(0)));`;
  const fixture = await ownedProcess(code);
  try {
    const descendantPid = Number(await readyLine(fixture.child.stdout));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
    assert.equal((await fixture.child.exited).code, 0);
    await fixture.child.terminate();
    assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' }, 'a stopped root is not a stopped group');
  } finally {
    await fixture.cleanup();
  }
});

test(
  'TERM-resistant owned roots are killed and simultaneous termination shares one completion',
  posixOnly,
  async () => {
    const fixture = await ownedProcess(
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);",
    );
    try {
      await readyLine(fixture.child.stdout);
      const first = fixture.child.terminate();
      assert.equal(fixture.child.terminate(), first);
      await first;
      assert.equal((await fixture.child.exited).signal, 'SIGKILL');
    } finally {
      await fixture.cleanup();
    }
  },
);

test('natural group retirement never sends a later destructive signal through a stale PID', posixOnly, async () => {
  const fixture = await ownedProcess('process.exit(0);');
  const rawKill = process.kill;
  const lateSignals = [];
  try {
    await fixture.child.exited;
    await delay(50);
    process.kill = (pid, signal) => {
      if (pid === -fixture.child.pid && signal !== 0) lateSignals.push(signal);
      return rawKill(pid, signal);
    };
    await fixture.child.terminate();
    await fixture.child.terminate();
    assert.deepEqual(lateSignals, [], 'retirement permanently ends signal authority for this numeric PID');
  } finally {
    process.kill = rawKill;
    await fixture.cleanup();
  }
});

test('permission refusal remains failure and never upgrades to a destructive signal', posixOnly, async () => {
  const fixture = await ownedProcess("process.stdout.write('ready\\n');setInterval(()=>{},1000);");
  const rawKill = process.kill;
  const signals = [];
  try {
    await readyLine(fixture.child.stdout);
    process.kill = (pid, signal) => {
      if (pid !== -fixture.child.pid) return rawKill(pid, signal);
      signals.push(signal);
      throw Object.assign(new Error('injected permission refusal'), { code: 'EPERM' });
    };
    await assert.rejects(fixture.child.terminate(), { code: 'EPERM' });
    assert.equal(signals.includes('SIGKILL'), false);
  } finally {
    process.kill = rawKill;
    await fixture.cleanup();
  }
});

test('an owned group that cannot be confirmed stopped rejects within a bound', posixOnly, async () => {
  const fixture = await ownedProcess("process.stdout.write('ready\\n');setInterval(()=>{},1000);");
  const rawKill = process.kill;
  let watchdog;
  try {
    await readyLine(fixture.child.stdout);
    process.kill = (pid, signal) => (pid === -fixture.child.pid ? true : rawKill(pid, signal));
    await assert.rejects(
      Promise.race([
        fixture.child.terminate(),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('termination exceeded test watchdog')), 2_000);
        }),
      ]),
      /process group termination unconfirmed/,
    );
  } finally {
    clearTimeout(watchdog);
    process.kill = rawKill;
    await fixture.cleanup();
  }
});

test('uncertain observations after TERM never grant permission to send KILL', posixOnly, async () => {
  const fixture = await ownedProcess("process.stdout.write('ready\\n');setInterval(()=>{},1000);");
  const rawKill = process.kill;
  const signals = [];
  let termRequested = false;
  try {
    await readyLine(fixture.child.stdout);
    process.kill = (pid, signal) => {
      if (pid !== -fixture.child.pid) return rawKill(pid, signal);
      signals.push(signal);
      if (signal === 'SIGTERM') {
        termRequested = true;
        return true;
      }
      if (termRequested) throw Object.assign(new Error('group observation denied'), { code: 'EPERM' });
      return true;
    };
    await assert.rejects(fixture.child.terminate(), { code: 'EPERM' });
    assert.equal(signals.includes('SIGKILL'), false);
  } finally {
    process.kill = rawKill;
    await fixture.cleanup();
  }
});

test('a live process reusing an exited root identity never receives group signals', posixOnly, async () => {
  const descendant =
    "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),4000);";
  const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>process.stdout.write(String(c.pid)+'\\n',()=>process.exit(0)));`;
  const fixture = await ownedProcess(code);
  const rawKill = process.kill;
  const destructive = [];
  try {
    process.kill = (pid, signal) => {
      if (pid === fixture.child.pid && signal === 0) return true;
      if (pid === -fixture.child.pid && signal !== 0) destructive.push(signal);
      return rawKill(pid, signal);
    };
    await readyLine(fixture.child.stdout);
    await fixture.child.exited;
    await assert.rejects(fixture.child.terminate(), /process group identity unconfirmed/);
    assert.deepEqual(destructive, []);
  } finally {
    process.kill = rawKill;
    await fixture.cleanup();
  }
});

for (const timing of ['natural-exit', 'close-reply-race', 'close-still-running']) {
  test(`one initial observation EPERM settles through fresh group evidence (${timing})`, posixOnly, async () => {
    const fixture = await ownedProcess(
      timing === 'close-still-running'
        ? "process.stdout.write('ready\\n');process.stdin.once('data',()=>{});"
        : "process.stdout.write('ready\\n');process.stdin.once('data',()=>process.exit(0));",
      200,
    );
    const rawKill = process.kill;
    const observations = [];
    let injected = false;
    try {
      await readyLine(fixture.child.stdout);
      process.kill = (pid, signal) => {
        if (pid !== -fixture.child.pid) return rawKill(pid, signal);
        if (signal !== 0) {
          assert.equal(signal, 'SIGTERM', 'this fixture must never need KILL');
          assert.deepEqual(
            observations.at(-1),
            { signal: 0, result: 'present' },
            'uncertainty cannot authorize TERM without a fresh successful observation',
          );
        }
        const observation = { signal, result: 'pending' };
        observations.push(observation);
        if (signal === 0 && !injected) {
          injected = true;
          observation.result = 'EPERM';
          throw Object.assign(new Error('one transient group observation denial'), { code: 'EPERM' });
        }
        try {
          const result = rawKill(pid, signal);
          observation.result = signal === 0 ? 'present' : 'sent';
          return result;
        } catch (error) {
          observation.result = error.code ?? error.name;
          throw error;
        }
      };
      fixture.child.stdin.write('quit\n');
      if (timing === 'natural-exit') await fixture.child.exited;
      await fixture.child.terminate();
      await fixture.child.terminate();
      assert.equal(injected, true);
      const exit = await fixture.child.exited;
      const diagnostic = JSON.stringify({ exit, observations });
      // Writing quit does not prove the child has processed it before the next
      // group observation. Both natural exit and an authorized TERM are valid.
      assert.ok(
        (exit.code === 0 && exit.signal === null) || (exit.code === null && exit.signal === 'SIGTERM'),
        diagnostic,
      );
      if (timing === 'natural-exit') {
        assert.equal(exit.code, 0, diagnostic);
        assert.ok(
          observations.every(({ signal }) => signal === 0),
          diagnostic,
        );
      }
      if (timing === 'close-still-running') assert.equal(exit.signal, 'SIGTERM', diagnostic);
    } finally {
      process.kill = rawKill;
      await fixture.cleanup();
    }
  });
}

test('a fresh positive observation after one EPERM still permits stopping the owned live root', posixOnly, async () => {
  const fixture = await ownedProcess("process.stdout.write('ready\\n');setInterval(()=>{},1000);", 100);
  const rawKill = process.kill;
  let injected = false;
  try {
    await readyLine(fixture.child.stdout);
    process.kill = (pid, signal) => {
      if (pid === -fixture.child.pid && signal === 0 && !injected) {
        injected = true;
        throw Object.assign(new Error('one observation unavailable'), { code: 'EPERM' });
      }
      return rawKill(pid, signal);
    };
    await fixture.child.terminate();
    assert.equal(injected, true);
    assert.equal((await fixture.child.exited).signal, 'SIGTERM');
  } finally {
    process.kill = rawKill;
    await fixture.cleanup();
  }
});
