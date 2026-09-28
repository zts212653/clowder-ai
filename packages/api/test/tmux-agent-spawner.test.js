import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';
import { spawnCliInTmuxForTest } from './helpers/tmux-test-spawn.js';

describe('spawnCliInTmux', () => {
  const WORKTREE = `test-agent-spawn-${Date.now()}`;
  let gateway;

  before(() => {
    gateway = new TmuxGateway();
  });

  afterEach(async () => {
    await gateway.destroyServer(WORKTREE);
  });

  it('yields NDJSON events from a simple echo command', async (t) => {
    const events = [];
    // echo command that outputs two JSON lines
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo \'{"type":"init","id":"t1"}\'; echo \'{"type":"done"}\''],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-1',
        cwd: '/tmp',
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    // First event should be pane creation metadata
    const paneEvent = events.find((e) => e.__tmuxPaneCreated);
    assert.ok(paneEvent, 'should yield __tmuxPaneCreated event');
    assert.ok(paneEvent.paneId, 'paneId should be set');
    assert.equal(paneEvent.worktreeId, WORKTREE);

    // Should have our two JSON events
    const jsonEvents = events.filter((e) => e.type);
    assert.ok(jsonEvents.length >= 2, `expected >=2 JSON events, got ${jsonEvents.length}`);
    assert.equal(jsonEvents[0].type, 'init');
    assert.equal(jsonEvents[0].id, 't1');
    assert.equal(jsonEvents[1].type, 'done');
  });

  it('forwards stdinInput to the pane command via stdin redirect (P1 regression)', async (t) => {
    // Incident 2026-05-29 P1 (cloud codex review): codex `-- -` reads prompt from stdin,
    // but a tmux pane has no stdin pipe. stdinInput must be redirected from a temp file.
    // Real tmux pane round-trip — guards the production worktree path that mock/dogfood missed.
    const SECRET = 'TMUX-STDIN-REDIRECT-披着专业外衣-R8';
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: process.execPath,
        args: [
          '-e',
          'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"stdin-echo",got:d})+"\\n")})',
        ],
        stdinInput: SECRET,
        worktreeId: WORKTREE,
        invocationId: 'test-inv-stdin',
        cwd: '/tmp',
      },
      { tmuxGateway: gateway },
    );
    for await (const event of gen) events.push(event);
    const echo = events.find((e) => e.type === 'stdin-echo');
    assert.ok(echo, 'pane command should receive stdin and echo it back');
    assert.equal(echo.got, SECRET, 'stdinInput must reach the pane command via stdin redirect');
  });

  it('cleans up the stdin temp file when tmux setup fails (P1 #2 regression)', async (t) => {
    // Incident 2026-05-29 P1 #2 (cloud codex review): the stdin temp file holds the full
    // conversation history. If setup fails before the main try/finally, it must still be
    // removed — otherwise the prompt is left on disk forever. Mock createAgentPaneLease to throw.
    const failGateway = {
      createAgentPaneLease: async () => {
        throw new Error('tmux unavailable (simulated setup failure)');
      },
    };
    const uniqueInv = `test-cleanup-${Date.now()}`;
    let threw = false;
    try {
      const gen = spawnCliInTmuxForTest(
        t,
        {
          command: '/bin/sh',
          args: ['-c', 'true'],
          stdinInput: 'SECRET-PROMPT-should-be-cleaned-披着专业外衣',
          worktreeId: WORKTREE,
          invocationId: uniqueInv,
          cwd: '/tmp',
        },
        { tmuxGateway: failGateway },
      );
      for await (const _event of gen) {
        /* drain */
      }
    } catch {
      threw = true;
    }
    assert.ok(threw, 'setup failure should propagate to the caller');
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const leftover = (await readdir(tmpdir())).filter((d) => d.includes(uniqueInv));
    assert.equal(leftover.length, 0, `stdin temp dir must be cleaned up on setup failure, found: ${leftover}`);
  });

  it('reports non-zero exit code via __cliError', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo \'{"type":"start"}\'; exit 42'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-2',
        cwd: '/tmp',
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.ok(errEvent, 'should yield __cliError on non-zero exit');
    assert.equal(errEvent.exitCode, 42);
  });

  // F212 round-4: tmux stderr classification verified on both modes.
  // plainText mode: stderrFile populated via L62-64 independent redirect; abnormal exit reads it.
  // NDJSON mode: stderr merges into fifo via 2>&1; non-JSON lines collected from parse-error branch
  //              (bounded nonJsonOutput buffer) feed buildCliDiagnostics — see L294 in tmux-agent-spawner.ts.
  it('F212: __cliError on non-zero exit carries cliDiagnostics built from stderr (plainText mode)', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        // stderr contains "401 Unauthorized" → classifier should map to auth_failed
        args: ['-c', 'echo plain-stdout; echo "Error: 401 Unauthorized" >&2; exit 42'],
        outputMode: 'plainText',
        worktreeId: WORKTREE,
        invocationId: 'test-inv-classify',
        cwd: '/tmp',
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.ok(errEvent, 'should yield __cliError');
    assert.equal(errEvent.exitCode, 42);
    assert.ok(errEvent.cliDiagnostics, 'cliDiagnostics must be present');
    assert.equal(
      errEvent.cliDiagnostics.reasonCode,
      'auth_failed',
      `tmux stderr must feed classification; got reasonCode=${errEvent.cliDiagnostics.reasonCode}, safeExcerpt=${errEvent.cliDiagnostics.safeExcerpt}`,
    );
    assert.ok(errEvent.cliDiagnostics.safeExcerpt, 'safeExcerpt should be filled for known reasonCode');
    assert.ok(
      errEvent.cliDiagnostics.safeExcerpt.includes('401 Unauthorized'),
      `safeExcerpt should include matched line: ${errEvent.cliDiagnostics.safeExcerpt}`,
    );
  });

  // F212 round-4 (砚砚 P2): NDJSON mode also classifies stderr via nonJsonOutput buffer.
  // tmux NDJSON command does `2>&1 | tee fifo` so stderr noise lands as non-JSON lines in
  // the NDJSON parse loop. parse-error branch collects them (bounded) → fed to buildCliDiagnostics.
  it('F212: __cliError carries cliDiagnostics built from non-JSON noise (NDJSON mode)', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        // Emit one valid NDJSON event + stderr "401 Unauthorized" noise + non-zero exit.
        // 2>&1 merges stderr→stdout fifo; the "Error: 401 Unauthorized" line lands in
        // the JSON parse-error branch and gets collected for classification.
        args: ['-c', 'echo \'{"type":"start"}\'; echo "Error: 401 Unauthorized" >&2; exit 42'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-ndjson-classify',
        cwd: '/tmp',
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.ok(errEvent, 'should yield __cliError');
    assert.equal(errEvent.exitCode, 42);
    assert.ok(errEvent.cliDiagnostics, 'cliDiagnostics must be present');
    assert.equal(
      errEvent.cliDiagnostics.reasonCode,
      'auth_failed',
      `NDJSON mode stderr noise must feed classification; got reasonCode=${errEvent.cliDiagnostics.reasonCode}, safeExcerpt=${errEvent.cliDiagnostics.safeExcerpt}`,
    );
    assert.ok(
      errEvent.cliDiagnostics.safeExcerpt?.includes('401 Unauthorized'),
      `safeExcerpt should include matched line: ${errEvent.cliDiagnostics.safeExcerpt}`,
    );
  });

  it('exit code 0 does not yield __cliError', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo \'{"type":"ok"}\'; exit 0'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-3',
        cwd: '/tmp',
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.equal(errEvent, undefined, 'should NOT yield __cliError on exit 0');
  });

  // F212 Phase H R1 P1-1 (Sol runtime forensics 2026-07-10, cloud codex bot echo):
  // Deleting the provider-side suppress branch (AC-H1/H2) exposed a canonical-truth-source
  // gap: cli-spawn.ts:657 already honors semanticCompletionSignal (turn.completed → abort =
  // silent success even if CLI exits non-zero), but tmux-agent-spawner.ts:402 did NOT. So
  // `turn.completed → exit 1` regressed for tmux-backed cats. R1 fix mirrors the direct-spawn
  // gate. Simulation: caller signal already aborted before iteration completes (as if
  // CodexAgentService.turn.completed handler had fired mid-stream). Expected: no __cliError.
  it('F212 Phase H R1 P1-1: semanticCompletionSignal.aborted suppresses __cliError on non-zero exit', async (t) => {
    const events = [];
    const controller = new AbortController();
    // Pre-abort — simulates provider's turn.completed handler flipping the signal
    // before the tmux stdout iteration reaches exit.
    controller.abort();
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo \'{"type":"turn.completed"}\'; exit 1'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-semantic-done',
        cwd: '/tmp',
        semanticCompletionSignal: controller.signal,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.equal(
      errEvent,
      undefined,
      'exit=1 with semanticDone MUST NOT yield __cliError (parity with cli-spawn.ts:657)',
    );
  });

  // F212 Phase H cloud R5 P2 (2026-07-10): the R1 P1-1 fix originally read
  // `semanticCompletionSignal.aborted` — but that signal is sticky. In a multi-turn
  // tmux stream, `turn.completed` (turn 1) → signal aborted; `turn.failed` (turn 2)
  // cannot un-abort → sticky "semanticDone=true" → exit=1 gets suppressed even
  // when the FINAL terminal was a real failure. Fix (cloud R5): key off
  // `localFinalTerminal` (chronological last terminal event) instead of the
  // sticky signal. These tests lock the new contract.

  it('F212 Phase H cloud R5 P2: multi-turn tmux (turn.completed then turn.failed) → __cliError surfaces', async (t) => {
    // Simulates the exact multi-turn regression cloud flagged. Pre-abort the signal
    // (so old R1 P1-1 code would have suppressed) but emit turn.completed followed by
    // turn.failed — under the R5 fix, localFinalTerminal='failed' wins over sticky signal.
    const events = [];
    const controller = new AbortController();
    controller.abort();
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: [
          '-c',
          'echo \'{"type":"turn.completed"}\'; echo \'{"type":"turn.failed","error":{"message":"real failure"}}\'; exit 1',
        ],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-multi-turn-fail',
        cwd: '/tmp',
        semanticCompletionSignal: controller.signal,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.ok(errEvent, 'multi-turn where final terminal is turn.failed MUST surface __cliError');
    assert.equal(errEvent.exitCode, 1);
  });

  it('F212 Phase H cloud R5 P2 companion: multi-turn tmux (turn.failed then recovery turn.completed) → silent success', async (t) => {
    // Opposite direction: attempt #1 fails, retry succeeds. Final terminal = completed.
    // R1 P1-1 tolerance for recovery must survive R5 fix.
    const events = [];
    const controller = new AbortController();
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: [
          '-c',
          'echo \'{"type":"turn.failed","error":{"message":"transient"}}\'; echo \'{"type":"turn.completed"}\'; exit 1',
        ],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-multi-turn-recover',
        cwd: '/tmp',
        semanticCompletionSignal: controller.signal,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.equal(
      errEvent,
      undefined,
      'recovery (final terminal = turn.completed) MUST NOT surface __cliError even after prior turn.failed',
    );
  });

  it('F212 Phase H R1 P1-1 companion: semanticCompletionSignal NOT aborted → __cliError fires normally', async (t) => {
    // Guard against over-suppression: without semanticDone, tmux still surfaces exit=1
    // via __cliError so terminal failures are not swallowed.
    const events = [];
    const controller = new AbortController();
    // NOT aborted — represents a turn that ended without turn.completed
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo \'{"type":"item.completed"}\'; exit 1'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-semantic-not-done',
        cwd: '/tmp',
        semanticCompletionSignal: controller.signal,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const errEvent = events.find((e) => e.__cliError);
    assert.ok(errEvent, 'exit=1 without semanticDone MUST surface __cliError');
    assert.equal(errEvent.exitCode, 1);
  });

  it('plainText mode yields raw stdout without NDJSON parsing', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo plain-output; echo debug-log >&2'],
        outputMode: 'plainText',
        worktreeId: WORKTREE,
        invocationId: 'test-inv-plaintext',
        cwd: '/tmp',
        timeoutMs: 5000,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const plain = events.find((e) => e.__cliPlainText);
    assert.ok(plain, 'should yield raw plain-text stdout result');
    assert.equal(plain.stdout, 'plain-output\n');
    assert.equal(plain.stderr, 'debug-log\n');
    assert.equal(plain.exitCode, 0);
  });

  it('plainText mode resets timeout on stdout chunks without newline', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'printf part1; sleep 1; printf part2; sleep 1; printf done'],
        outputMode: 'plainText',
        worktreeId: WORKTREE,
        invocationId: 'test-inv-plaintext-no-newline',
        cwd: '/tmp',
        timeoutMs: 1500,
        firstEventTimeoutMs: 8000,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const timeout = events.find((e) => e.__cliTimeout);
    assert.equal(timeout, undefined, 'stdout chunks without newline should keep the process alive');
    const plain = events.find((e) => e.__cliPlainText);
    assert.ok(plain, 'should yield raw plain-text stdout result');
    assert.equal(plain.stdout, 'part1part2done');
    assert.equal(plain.exitCode, 0);
  });

  it('plainText mode does not time out after stdout reaches EOF while the exit sentinel is pending', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'printf done; exec 1>&-; sleep 0.5'],
        outputMode: 'plainText',
        worktreeId: WORKTREE,
        invocationId: 'test-inv-plaintext-eof-before-exit-sentinel',
        cwd: '/tmp',
        timeoutMs: 100,
        firstEventTimeoutMs: 8000,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const timeout = events.find((e) => e.__cliTimeout);
    assert.equal(timeout, undefined, 'completed stdout must retire the idle timer before exit-code polling');
    const plain = events.find((e) => e.__cliPlainText);
    assert.ok(plain, 'should yield raw plain-text stdout result');
    assert.equal(plain.stdout, 'done');
    assert.equal(plain.exitCode, 0);
  });

  it('plainText mode resets timeout on stderr activity before final stdout', async (t) => {
    const events = [];
    // Vacuous-proof design (2026-09-07 Sol R3 P1 — explicit iterator ordering):
    //   Shell starts running at `execInPane()`, but `startFirstEventTimeout()`
    //   and `startPlainTextStderrWatcher()` are only armed AFTER
    //   `setAgentPaneReadOnly()` + `yield __tmuxPaneCreated` + generator resume.
    //   Under load, pre-arm setup can eat several seconds of real shell time,
    //   so fixed-duration commands are defeated: stdout can arrive inside the
    //   20 s budget even if the stderr watcher is inert.
    //
    //   Fix: a marker-file barrier — but the marker MUST be written AFTER the
    //   generator has resumed past `yield __tmuxPaneCreated` and executed the
    //   synchronous body that arms the timer + watcher. In a `for await` loop
    //   that ordering is impossible: the generator is suspended at yield until
    //   the consumer body returns and the loop calls `next()` again. Any
    //   `await setTimeout` inside the body is dead time — release still races
    //   the next `next()`. So this test drives the iterator manually:
    //     1. `iter.next()` → receive `__tmuxPaneCreated`; generator suspends
    //        at yield.
    //     2. `iter.next()` again (without awaiting) → the async generator
    //        synchronously resumes from yield and runs through the sync body
    //        (init state vars, `startFirstEventTimeout()`,
    //        `startPlainTextStderrWatcher()`) up to the first async point
    //        (`for await (chunk of fifoStream)`). Timer + watcher are now
    //        armed.
    //     3. `await setImmediate` → macrotask boundary as an extra guarantee
    //        the generator has settled at its FIFO await before we do
    //        anything shell-visible.
    //     4. `writeFileSync(marker)` → shell notices in ≤50 ms and begins
    //        the 30-iter stderr loop; total shell time from here is measured
    //        against the just-armed 20 s firstEventTimer.
    //     5. Drain the outstanding `next()` promise + the rest.
    //
    //   Mutation probe (Sol R3 direction): with an inert stderr watcher, this
    //   layout goes RED even under an arbitrarily slow `setAgentPaneReadOnly` or
    //   pre-first-event consumer delay, because release only happens after
    //   the timer is armed.
    const markerPath = join(tmpdir(), `tmux-firstevent-marker-${randomUUID()}`);
    try {
      const gen = spawnCliInTmuxForTest(
        t,
        {
          command: '/bin/sh',
          args: [
            '-c',
            `while [ ! -f "${markerPath}" ]; do sleep 0.05; done; i=1; while [ "$i" -le 30 ]; do echo "progress-$i" >&2; sleep 0.75; i=$((i+1)); done; echo done`,
          ],
          outputMode: 'plainText',
          worktreeId: WORKTREE,
          invocationId: 'test-inv-plaintext-stderr-progress',
          cwd: '/tmp',
          timeoutMs: 1500,
          firstEventTimeoutMs: 20_000,
        },
        { tmuxGateway: gateway },
      );

      const iter = gen[Symbol.asyncIterator]();

      // Step 1: consume the __tmuxPaneCreated event (generator now suspended
      // at the yield that follows tmux pane setup).
      const first = await iter.next();
      assert.equal(first.done, false, 'generator should yield the pane-created event first');
      assert.ok(first.value?.__tmuxPaneCreated, 'first yielded event must be __tmuxPaneCreated');
      events.push(first.value);

      // Step 2: kick off the next iteration — this synchronously resumes the
      // generator through startFirstEventTimeout() + startPlainTextStderrWatcher()
      // up to the first async point (the FIFO for-await). Do NOT await yet.
      const drainPromise = iter.next();

      // Step 3: yield a macrotask so the generator has definitely settled at
      // its FIFO await before any shell-visible action happens.
      await new Promise((resolve) => setImmediate(resolve));

      // Step 4: release the shell. Timer + watcher are already armed, so the
      // 22.5 s stderr loop and stdout arrival now share a clock origin with
      // the 20 s firstEventTimer. Only the stderr watcher can cancel it.
      writeFileSync(markerPath, '');

      // Step 5: drain the rest of the stream.
      let result = await drainPromise;
      while (!result.done) {
        events.push(result.value);
        result = await iter.next();
      }

      const timeout = events.find((e) => e.__cliTimeout);
      assert.equal(
        timeout,
        undefined,
        'stderr activity should cancel first-event timer before final stdout (which arrives after the 20s budget)',
      );
      const plain = events.find((e) => e.__cliPlainText);
      assert.ok(plain, 'should yield raw plain-text stdout result');
      assert.equal(plain.stdout, 'done\n');
      // Full stderr sequence must land — proves stderr progress kept the run
      // alive across the entire 22.5s post-marker window, not just the first
      // few writes before an idle timeout would otherwise fire.
      assert.match(plain.stderr, /progress-30/);
      assert.equal(plain.exitCode, 0);
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        /* best-effort: marker may have been consumed or never created */
      }
    }
  });

  // NOTE: F212 deadline-callback sync-recheck regression lives in
  // `tmux-agent-spawner-deadline-recheck.test.js` (deterministic 4-cell
  // fake-gateway) — Sol R1 P1 flagged that a real-tmux timing-based
  // integration test cannot deterministically execute the sync-recheck
  // code path (the 250 ms interval poll rescues first under any
  // `firstEventTimeoutMs` ≥ 250 ms). See that file for the actual gate.

  it('sets environment variables in pane', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'echo "{\\"val\\":\\"$TEST_VAR\\"}"'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-4',
        cwd: '/tmp',
        env: { TEST_VAR: 'hello-tmux' },
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const valEvent = events.find((e) => e.val);
    assert.ok(valEvent, 'should have event with val field');
    assert.equal(valEvent.val, 'hello-tmux');
  });

  it('parse-error noise does not reset timeout forever', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'while true; do echo not-json-line; sleep 0.05; done'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-timeout-noise',
        cwd: '/tmp',
        timeoutMs: 200,
        firstEventTimeoutMs: 200, // No valid events → firstEventTimeout fires
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const timeoutEvent = events.find((e) => e.__cliTimeout);
    assert.ok(timeoutEvent, 'invalid tmux output noise should still hit timeout');
  });

  it('firstEventTimeout fires when CLI produces no valid NDJSON', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        // Sleep forever — never produces any output at all
        args: ['-c', 'sleep 3600'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-first-event-timeout',
        cwd: '/tmp',
        firstEventTimeoutMs: 300,
        timeoutMs: 60000, // idle timeout much larger — should NOT be the one that fires
      },
      { tmuxGateway: gateway },
    );

    const start = Date.now();
    for await (const event of gen) {
      events.push(event);
    }
    const elapsed = Date.now() - start;

    const timeoutEvent = events.find((e) => e.__cliTimeout);
    assert.ok(timeoutEvent, 'should yield __cliTimeout from firstEventTimeout');
    assert.match(timeoutEvent.message, /启动超时/, 'message should mention startup timeout');
    // Should converge around firstEventTimeoutMs, not idleTimeoutMs
    assert.ok(elapsed < 5000, `should converge via firstEventTimeout, took ${elapsed}ms`);
  });

  it('idleTimeout fires after first event when CLI goes silent', async (t) => {
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        // Emit one valid event, then sleep forever
        args: ['-c', 'echo \'{"type":"init"}\'; sleep 3600'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-idle-timeout',
        cwd: '/tmp',
        firstEventTimeoutMs: 60000, // first event timeout much larger
        timeoutMs: 300, // idle timeout should fire
      },
      { tmuxGateway: gateway },
    );

    const start = Date.now();
    for await (const event of gen) {
      events.push(event);
    }
    const elapsed = Date.now() - start;

    const timeoutEvent = events.find((e) => e.__cliTimeout);
    assert.ok(timeoutEvent, 'should yield __cliTimeout from idleTimeout');
    assert.match(timeoutEvent.message, /idle/, 'message should mention idle timeout');
    assert.equal(timeoutEvent.timeoutMs, 300, 'timeout metadata should identify the idle timeout');
    // Should have received the init event before timeout
    const initEvent = events.find((e) => e.type === 'init');
    assert.ok(initEvent, 'should have received the init event before idle timeout fired');
    // killAgent's C-c + 3s grace + kill-pane adds overhead; we tear down the
    // tmux server after each test, but full-suite load can still stretch wall-clock time.
    assert.ok(elapsed < 30000, `should converge well before firstEventTimeout, took ${elapsed}ms`);
  });

  it('AbortSignal unblocks FIFO read (no deadlock)', async (t) => {
    const ac = new AbortController();
    const events = [];
    const gen = spawnCliInTmuxForTest(
      t,
      {
        command: '/bin/sh',
        args: ['-c', 'sleep 3600'],
        worktreeId: WORKTREE,
        invocationId: 'test-inv-abort-fifo',
        cwd: '/tmp',
        signal: ac.signal,
        firstEventTimeoutMs: 60000,
        timeoutMs: 60000,
      },
      { tmuxGateway: gateway },
    );

    // Abort after 200ms — should unblock FIFO read
    setTimeout(() => ac.abort(), 200);

    const start = Date.now();
    for await (const event of gen) {
      events.push(event);
    }
    const elapsed = Date.now() - start;

    // Should converge quickly via abort, not hang forever
    assert.ok(elapsed < 5000, `abort should unblock FIFO read, took ${elapsed}ms`);
  });

  it('pane has remain-on-exit set', async () => {
    // Create an agent pane and verify remain-on-exit
    const paneId = await gateway.createAgentPane(WORKTREE, { cwd: '/tmp' });
    assert.ok(paneId, 'pane should be created');

    // Check tmux option
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const sock = gateway.socketName(WORKTREE);
    const { stdout } = await exec('tmux', ['-L', sock, 'show-option', '-t', paneId, 'remain-on-exit']);
    assert.match(stdout.trim(), /on/, 'remain-on-exit should be on');
  });
});
