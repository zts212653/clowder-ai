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
    // Should have received the init event before timeout
    const initEvent = events.find((e) => e.type === 'init');
    assert.ok(initEvent, 'should have received the init event before idle timeout fired');
    // killAgent's C-c + 3s grace + kill-pane adds overhead; we tear down the
    // tmux server after each test to keep this bound stable across the suite.
    assert.ok(elapsed < 15000, `should converge via idleTimeout, took ${elapsed}ms`);
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
