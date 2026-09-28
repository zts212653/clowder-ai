/**
 * F212 post-close hotfix (2026-09-07) deterministic Red→Green regression.
 * Full R1→R4 history is in docs/features/F212-cli-error-diagnostics.md.
 *
 * Contract: each deadline callback rescue has 3 obligations —
 *   1. detect activity (call `pollStderrActivity()`);
 *   2. leave a live successor deadline (via `recordPlainTextActivity()`
 *      → `resetIdleTimeout()`);
 *   3. NOT commit the current timeout/kill.
 *
 * Harness: fake `TmuxGateway` (creation reads the private command file to extract
 * stderr/fifo/exit paths + pre-writes `EXIT:0`) + in-scope monkey-patched
 * global timers. 200 ms first-event / 1500 ms idle / 250 ms poll captured
 * as stateful `{ id, fn, active }` handles; fake `clearTimeout` marks
 * inactive; every idle re-arm pushes to `idleHandles`. The 3000 ms
 * `killAgent` grace is shortened + wired to close the FIFO writer AND
 * increment `killStartCount` — `killAgent()` reaches that setTimeout
 * before its first await, so the increment is a synchronous "did the
 * kill path start?" observation. Test opens the FIFO R/W (O_NONBLOCK) to
 * unblock `createReadStream`. `originals` restore in `finally`.
 *
 * Rescue cells (1, 3) prove all three obligations:
 *   (a) `killStartCount === 0` after the rescue callback (#3);
 *   (b) `idleHandles` grew AND `latestIdle().active === true` (#2);
 *   (c) drain FIFO with `done\n` and assert no `__cliTimeout` +
 *       `plain.stdout === 'done\n'` — belt-and-suspenders for a latent
 *       `timedOut = true` from a fell-through kill (secondary #3).
 * Obligation #1 is implied by (b) — resetIdleTimeout only runs from
 * recordPlainTextActivity which only runs from a successful
 * pollStderrActivity. `fireIdle` rejects inactive handles for stale-
 * reference safety.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { describe, it } from 'node:test';
import { spawnCliInTmux } from '../dist/domains/terminal/tmux-agent-spawner.js';

const FIRST_EVENT_MS = 200;
const IDLE_MS = 1500;
const POLL_MS = 250;
const KILL_GRACE_MS = 3000;

/**
 * Set up the fake gateway, stateful timer capture, and generator boot.
 * Returns the control surface the individual cells drive.
 */
async function bootScenario() {
  let stderrPath;
  let fifoPath;
  let writerFd;

  const gateway = {
    createAgentPaneLease: async (worktreeId, options) => {
      const command = readFileSync(options.command.at(-1), 'utf8');
      stderrPath = command.match(/2> '([^']+)'/)[1];
      fifoPath = command.match(/\/tee' '([^']+)'/)[1];
      const exitPath = command.match(/> '([^']+\/exit-code)'/)[1];
      writeFileSync(exitPath, 'EXIT:0');
      return { worktreeId, paneId: '%1', panePid: '123', token: '11111111-1111-1111-1111-111111111111' };
    },
    setAgentPaneReadOnly: () => true,
    interruptAgentPane: () => true,
    killAgentPane: () => true,
  };

  const abort = new AbortController();
  const gen = spawnCliInTmux(
    {
      command: '/bin/sh',
      args: ['-c', 'true'],
      outputMode: 'plainText',
      worktreeId: 'isolated-diagnostic',
      invocationId: randomUUID(),
      timeoutMs: IDLE_MS,
      firstEventTimeoutMs: FIRST_EVENT_MS,
      signal: abort.signal,
    },
    { tmuxGateway: gateway },
  );

  const first = await gen.next();
  assert.equal(first.value?.__tmuxPaneCreated, true, 'generator must yield __tmuxPaneCreated first');
  writerFd = openSync(fifoPath, constants.O_RDWR | constants.O_NONBLOCK);

  const original = { setTimeout, clearTimeout, setInterval, clearInterval };
  const fakes = new Map();
  let nextId = 1;
  let firstEventHandle = null;
  const idleHandles = [];
  let pollHandle = null;
  let killStartCount = 0;

  const closeWriter = () => {
    if (writerFd !== undefined) {
      closeSync(writerFd);
      writerFd = undefined;
    }
  };

  const stub = (fn, ms) => {
    const handle = { id: nextId++, fn, ms, active: true };
    fakes.set(handle, true);
    return handle;
  };

  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === FIRST_EVENT_MS) {
      const h = stub(() => fn(...args), ms);
      firstEventHandle = h;
      return h;
    }
    if (ms === IDLE_MS) {
      const h = stub(() => fn(...args), ms);
      idleHandles.push(h);
      return h;
    }
    if (ms === KILL_GRACE_MS) {
      // killAgent's 3s tmux grace is our synchronous "kill path started"
      // observation point (killAgent reaches its first await here, before
      // the pane-kill execFileSync). Increment BEFORE firing the callback
      // so rescue cells can assert `killStartCount === 0` immediately
      // after the deadline callback returns.
      killStartCount += 1;
      return original.setTimeout(() => {
        closeWriter();
        fn(...args);
      }, 0);
    }
    return original.setTimeout(fn, ms, ...args);
  };
  globalThis.setInterval = (fn, ms, ...args) => {
    if (ms === POLL_MS) {
      const h = stub(() => fn(...args), ms);
      pollHandle = h;
      return h;
    }
    return original.setInterval(fn, ms, ...args);
  };
  globalThis.clearTimeout = (h) => {
    if (h && fakes.has(h)) {
      h.active = false;
      return;
    }
    original.clearTimeout(h);
  };
  globalThis.clearInterval = (h) => {
    if (h && fakes.has(h)) {
      h.active = false;
      return;
    }
    original.clearInterval(h);
  };

  // Kick the generator to arm both timers + settle at FIFO await.
  const pending = gen.next();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(firstEventHandle, 'first-event timer must be armed at generator resume');
  assert.ok(firstEventHandle.active, 'first-event handle must be active on arm');
  assert.ok(pollHandle, 'stderr poll interval must be armed at generator resume');
  assert.equal(idleHandles.length, 0, 'idle timer must be armed lazily (only on first activity)');
  assert.equal(killStartCount, 0, 'kill path must NOT have been started before any deadline fires');

  return {
    stderrPath,
    fireFirstEvent: () => {
      assert.ok(firstEventHandle.active, 'first-event handle must be active before firing');
      firstEventHandle.active = false;
      firstEventHandle.fn();
    },
    fireIdle: (index) => {
      const idx = index === undefined ? idleHandles.length - 1 : index;
      const h = idleHandles[idx];
      assert.ok(h, `expected idle handle at index ${idx}`);
      assert.ok(h.active, `idle handle at index ${idx} must be active before firing`);
      h.active = false;
      h.fn();
    },
    latestIdle: () => idleHandles[idleHandles.length - 1] ?? null,
    idleHandlesSnapshot: () => idleHandles.map((h) => ({ id: h.id, active: h.active })),
    getKillStartCount: () => killStartCount,
    completeShellSuccess: () => {
      writeSync(writerFd, 'done\n');
      closeWriter();
    },
    drain: async () => {
      const events = [];
      let next = await pending;
      while (!next.done) {
        events.push(next.value);
        next = await gen.next();
      }
      return events;
    },
    cleanup: async () => {
      abort.abort();
      closeWriter();
      try {
        await gen.return();
      } catch {
        /* best-effort */
      }
      Object.assign(globalThis, original);
    },
  };
}

describe('F212 hotfix: deadline callback stderr sync-recheck (deterministic 4-cell rescue+rearm+no-kill proof)', () => {
  it('cell 1: first-event rescue detects stderr, arms live idle, does NOT commit kill, drains normally', async () => {
    const s = await bootScenario();
    try {
      // Unpolled stderr on disk before the deadline fires.
      writeFileSync(s.stderrPath, 'progress-1\n');
      const idlesBefore = s.idleHandlesSnapshot();

      s.fireFirstEvent();

      // Obligation #3: rescue must NOT start the kill path. If a
      // missing-return mutation lets the callback fall through to
      // `killAgent()`, KILL_GRACE_MS setTimeout intercept bumps
      // killStartCount before firing.
      assert.equal(
        s.getKillStartCount(),
        0,
        'first-event rescue must NOT start killAgent() — a fell-through kill silently converts a spurious timeout into a hang',
      );
      // Obligation #2: rescue must arm a new live idle deadline.
      const idlesAfter = s.idleHandlesSnapshot();
      assert.equal(
        idlesAfter.length,
        idlesBefore.length + 1,
        'first-event rescue must install exactly one new idle handle via resetIdleTimeout()',
      );
      assert.ok(s.latestIdle()?.active, 'newly installed idle handle must be active after rescue');

      // Obligation #3 (secondary): drain the FIFO normally with a final
      // `done` chunk. If a latent `timedOut = true` was set by a
      // fell-through kill path, the generator will still yield
      // __cliTimeout after cleanup — asserting `timeout === undefined`
      // catches that class of mutation even if killStartCount inspection
      // is bypassed (belt + suspenders).
      s.completeShellSuccess();
      const events = await s.drain();
      assert.equal(
        events.find((e) => e.__cliTimeout),
        undefined,
        'rescue must NOT yield __cliTimeout at drain — a latent timedOut = true from a fell-through kill would surface here',
      );
      const plain = events.find((e) => e.__cliPlainText);
      assert.ok(plain, 'rescue must complete normally and yield __cliPlainText');
      assert.equal(plain.stdout, 'done\n');
    } finally {
      await s.cleanup();
    }
  });

  it('cell 2: first-event deadline + true silence → __cliTimeout + kill path starts', async () => {
    const s = await bootScenario();
    try {
      s.fireFirstEvent();
      // Genuine-silence control: opposite of rescue — kill must start
      // AND __cliTimeout must be yielded.
      assert.equal(s.getKillStartCount(), 1, 'first-event genuine-silence path must start killAgent()');
      const events = await s.drain();
      const timeout = events.find((e) => e.__cliTimeout);
      assert.ok(timeout, 'first-event deadline must yield __cliTimeout when stderr is truly empty');
      assert.equal(timeout.timeoutMs, FIRST_EVENT_MS, 'timeoutMs must reflect firstEventTimeoutMs');
    } finally {
      await s.cleanup();
    }
  });

  it('cell 3: idle rescue detects fresh stderr, arms distinct live idle, does NOT commit kill, drains normally', async () => {
    const s = await bootScenario();
    try {
      // Establish first activity so idle #1 is armed (production path
      // would use the interval poll; here we use the first-event rescue,
      // which is already covered by cell 1 as a rescue that arms idle).
      writeFileSync(s.stderrPath, 'seed\n');
      s.fireFirstEvent();
      const afterFirstEventRescue = s.idleHandlesSnapshot();
      assert.equal(afterFirstEventRescue.length, 1, 'first-event rescue must install idle #1 via resetIdleTimeout');
      assert.equal(s.getKillStartCount(), 0, 'first-event rescue in cell-3 setup must NOT start kill');

      // Idle rescue proper: write NEW stderr since last observation, then
      // fire idle #1.
      writeFileSync(s.stderrPath, 'seed\nprogress-2\n');
      const killStartBeforeIdleRescue = s.getKillStartCount();
      s.fireIdle(0);

      // Obligation #3: idle rescue must NOT start the kill path.
      assert.equal(
        s.getKillStartCount(),
        killStartBeforeIdleRescue,
        'idle rescue must NOT start killAgent() — a fell-through kill silently converts a spurious timeout into a hang',
      );
      // Obligation #2: idle rescue must arm a distinct new idle handle.
      const afterIdleRescue = s.idleHandlesSnapshot();
      assert.equal(afterIdleRescue.length, 2, 'idle rescue must install idle #2 via resetIdleTimeout');
      assert.equal(afterIdleRescue[0].active, false, 'idle #1 must be inactive after firing');
      assert.ok(afterIdleRescue[1].active, 'idle #2 must be active after rescue');
      assert.notEqual(afterIdleRescue[0].id, afterIdleRescue[1].id, 'idle #2 must be a distinct handle from idle #1');

      // Obligation #3 (secondary): drain normally with `done` — latent
      // timedOut catches even if killStartCount was somehow bypassed.
      s.completeShellSuccess();
      const events = await s.drain();
      assert.equal(
        events.find((e) => e.__cliTimeout),
        undefined,
        'idle rescue must NOT yield __cliTimeout at drain — a latent timedOut = true from a fell-through kill would surface here',
      );
      const plain = events.find((e) => e.__cliPlainText);
      assert.ok(plain, 'idle rescue must complete normally and yield __cliPlainText');
      assert.equal(plain.stdout, 'done\n');
    } finally {
      await s.cleanup();
    }
  });

  it('cell 4: idle deadline + first activity observed + no new stderr → __cliTimeout + kill path starts', async () => {
    const s = await bootScenario();
    try {
      // Establish first activity: write seed + fire first-event (its
      // sync-recheck marks activity and installs idle #1).
      writeFileSync(s.stderrPath, 'seed\n');
      s.fireFirstEvent();
      assert.equal(s.idleHandlesSnapshot().length, 1, 'first-event rescue must install idle #1');
      assert.equal(s.getKillStartCount(), 0, 'first-event rescue in cell-4 setup must NOT start kill');
      // Fire idle #1 with NO new stderr — genuine silence, must timeout.
      s.fireIdle(0);
      assert.equal(s.getKillStartCount(), 1, 'idle genuine-silence path must start killAgent()');
      const events = await s.drain();
      const timeout = events.find((e) => e.__cliTimeout);
      assert.ok(timeout, 'idle deadline must yield __cliTimeout when nothing new has landed on stderr');
      assert.equal(timeout.timeoutMs, IDLE_MS, 'timeoutMs must reflect idleTimeoutMs');
    } finally {
      await s.cleanup();
    }
  });
});
