import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { spawnCliInTmux } from '../dist/domains/terminal/tmux-agent-spawner.js';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

describe('spawnCliInTmux', () => {
  const WORKTREE = `test-agent-spawn-${Date.now()}`;
  let gateway;

  before(() => {
    gateway = new TmuxGateway();
  });

  afterEach(async () => {
    await gateway.destroyServer(WORKTREE);
  });

  it('yields NDJSON events from a simple echo command', async () => {
    const events = [];
    // echo command that outputs two JSON lines
    const gen = spawnCliInTmux(
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

  it('forwards stdinInput to the pane command via stdin redirect (P1 regression)', async () => {
    // Incident 2026-05-29 P1 (cloud codex review): codex `-- -` reads prompt from stdin,
    // but a tmux pane has no stdin pipe. stdinInput must be redirected from a temp file.
    // Real tmux pane round-trip — guards the production worktree path that mock/dogfood missed.
    const SECRET = 'TMUX-STDIN-REDIRECT-披着专业外衣-R8';
    const events = [];
    const gen = spawnCliInTmux(
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

  it('cleans up the stdin temp file when tmux setup fails (P1 #2 regression)', async () => {
    // Incident 2026-05-29 P1 #2 (cloud codex review): the stdin temp file holds the full
    // conversation history. If setup fails before the main try/finally, it must still be
    // removed — otherwise the prompt is left on disk forever. Mock createAgentPane to throw.
    const failGateway = {
      createAgentPane: async () => {
        throw new Error('tmux unavailable (simulated setup failure)');
      },
    };
    const uniqueInv = `test-cleanup-${Date.now()}`;
    let threw = false;
    try {
      const gen = spawnCliInTmux(
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

  it('reports non-zero exit code via __cliError', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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
  it('F212: __cliError on non-zero exit carries cliDiagnostics built from stderr (plainText mode)', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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
  it('F212: __cliError carries cliDiagnostics built from non-JSON noise (NDJSON mode)', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('exit code 0 does not yield __cliError', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('plainText mode yields raw stdout without NDJSON parsing', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('plainText mode resets timeout on stdout chunks without newline', async () => {
    const events = [];
    const gen = spawnCliInTmux(
      {
        command: '/bin/sh',
        args: ['-c', 'printf part1; sleep 1; printf part2; sleep 1; printf done'],
        outputMode: 'plainText',
        worktreeId: WORKTREE,
        invocationId: 'test-inv-plaintext-no-newline',
        cwd: '/tmp',
        timeoutMs: 1500,
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

  it('plainText mode resets timeout on stderr activity before final stdout', async () => {
    const events = [];
    const gen = spawnCliInTmux(
      {
        command: '/bin/sh',
        args: ['-c', 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "progress-$i" >&2; sleep 0.75; done; echo done'],
        outputMode: 'plainText',
        worktreeId: WORKTREE,
        invocationId: 'test-inv-plaintext-stderr-progress',
        cwd: '/tmp',
        timeoutMs: 1500,
        // Full gate load can delay tmux pane startup. Final stdout still lands
        // after this window, so stderr progress must cancel the startup timer.
        firstEventTimeoutMs: 8000,
      },
      { tmuxGateway: gateway },
    );

    for await (const event of gen) {
      events.push(event);
    }

    const timeout = events.find((e) => e.__cliTimeout);
    assert.equal(timeout, undefined, 'stderr activity should keep plainText tmux command alive before final stdout');
    const plain = events.find((e) => e.__cliPlainText);
    assert.ok(plain, 'should yield raw plain-text stdout result');
    assert.equal(plain.stdout, 'done\n');
    assert.match(plain.stderr, /progress-4/);
    assert.equal(plain.exitCode, 0);
  });

  it('sets environment variables in pane', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('parse-error noise does not reset timeout forever', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('firstEventTimeout fires when CLI produces no valid NDJSON', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('idleTimeout fires after first event when CLI goes silent', async () => {
    const events = [];
    const gen = spawnCliInTmux(
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

  it('AbortSignal unblocks FIFO read (no deadlock)', async () => {
    const ac = new AbortController();
    const events = [];
    const gen = spawnCliInTmux(
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
