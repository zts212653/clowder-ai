// F117 KD-22 (Phase J, J4): every dispatched member has one timeout, driven by CLI_TIMEOUT_MS — no
// real output for that long. Only output the model produced restarts it; heartbeats, status and
// diagnostics do not. While the member's process is using CPU it gets more time, but never more
// than 2 × CLI_TIMEOUT_MS since its last output.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { MemberOutputTimeout, isMemberOutput } = await import(
  '../dist/domains/cats/services/agents/invocation/member-output-timeout.js'
);

const T = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = { type: 'text', catId: 'opus', content: 'hi', timestamp: 0 };

function timeout(overrides = {}) {
  const fired = [];
  const timer = new MemberOutputTimeout({
    timeoutMs: T,
    probeProcess: () => 'absent',
    onTimeout: (diagnostics) => fired.push(diagnostics),
    invocationId: 'inv-child',
    ...overrides,
  });
  return { timer, fired };
}

describe('F117 J4: what counts as a member output', () => {
  it('counts text, tool calls and their results, thinking and rich blocks', () => {
    assert.equal(isMemberOutput(text), true);
    assert.equal(isMemberOutput({ type: 'tool_use', toolName: 'Bash' }), true);
    assert.equal(isMemberOutput({ type: 'tool_result', content: 'ok' }), true);
    assert.equal(
      isMemberOutput({ type: 'system_info', content: JSON.stringify({ type: 'thinking', text: '…' }) }),
      true,
    );
    assert.equal(
      isMemberOutput({ type: 'system_info', content: JSON.stringify({ type: 'rich_block', block: {} }) }),
      true,
    );
  });

  it('does not count heartbeats, status, diagnostics or bookkeeping', () => {
    for (const message of [
      { type: 'provider_signal', content: 'retrying' },
      { type: 'liveness_signal', content: 'still here' },
      { type: 'status', content: 'working' },
      { type: 'system_info', content: JSON.stringify({ type: 'liveness_warning' }) },
      { type: 'system_info', content: JSON.stringify({ type: 'timeout_diagnostics', silenceDurationMs: 1 }) },
      { type: 'system_info', content: JSON.stringify({ type: 'invocation_created' }) },
      { type: 'system_info', content: 'not json' },
      { type: 'session_init', sessionId: 's' },
      { type: 'agent_loop' },
    ]) {
      assert.equal(isMemberOutput(message), false, `${message.type} ${message.content ?? ''}`);
    }
  });
});

describe('F117 J4: the member output timeout', () => {
  it('rechecks measured silence when a timer callback arrives before the deadline', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 0;
    const { timer, fired } = timeout({ now: () => now, probeProcess: () => 'idle' });
    try {
      now = T - 1;
      t.mock.timers.tick(T);
      assert.equal(fired.length, 0, 'the measured silence deadline has not elapsed');
      now = T;
      t.mock.timers.tick(1);
      assert.equal(fired.length, 1);
      assert.equal(fired[0].silenceDurationMs, T);
      t.mock.timers.tick(T);
      assert.equal(fired.length, 1);
    } finally {
      timer.close();
    }
  });
  it('fires once when the member produces no output for CLI_TIMEOUT_MS', async () => {
    const { timer, fired } = timeout();
    await sleep(T * 3);
    timer.close();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].processAlive, true, 'a carrier without a probed process is still running');
    assert.equal(fired[0].invocationId, 'inv-child');
    assert.ok(fired[0].silenceDurationMs >= T);
  });

  it('restarts on output but not on heartbeats or status', async () => {
    const { timer, fired } = timeout();
    await sleep(T * 0.6);
    timer.observe(text);
    await sleep(T * 0.6);
    timer.observe({ type: 'liveness_signal', content: 'ping' });
    timer.observe({ type: 'status', content: 'still working' });
    assert.equal(fired.length, 0, 'output restarted the clock');
    await sleep(T * 0.8);
    timer.close();
    assert.equal(fired.length, 1, 'heartbeats and status did not');
    assert.equal(fired[0].lastEventType, 'text');
    assert.ok(fired[0].lastEventAt >= fired[0].firstEventAt);
  });

  it('gives a member whose process is using CPU more time, up to 2 × CLI_TIMEOUT_MS since its last output', async () => {
    const startedAt = Date.now();
    let firedAt;
    const { timer, fired } = timeout({
      probeProcess: () => 'busy',
      onTimeout: (diagnostics) => {
        firedAt = Date.now();
        fired.push(diagnostics);
      },
    });
    await sleep(T * 1.5);
    assert.equal(fired.length, 0, 'still busy at CLI_TIMEOUT_MS: deferred');
    await sleep(T * 1.5);
    timer.close();
    assert.equal(fired.length, 1, 'the deferral is capped');
    assert.ok(firedAt - startedAt >= 2 * T - 5 && firedAt - startedAt < 3 * T, `fired after ${firedAt - startedAt}ms`);
    assert.ok(fired[0].silenceDurationMs >= 2 * T - 5);
  });

  it('does not defer a member whose process is idle, and reports a dead one as not alive', async () => {
    const idle = timeout({ probeProcess: () => 'idle' });
    const dead = timeout({ probeProcess: () => 'dead' });
    await sleep(T * 1.5);
    idle.timer.close();
    dead.timer.close();
    assert.equal(idle.fired.length, 1);
    assert.equal(idle.fired[0].processAlive, true);
    assert.equal(dead.fired.length, 1);
    assert.equal(dead.fired[0].processAlive, false);
  });

  it('never fires when CLI_TIMEOUT_MS is 0, or after it was closed', async () => {
    const off = timeout({ timeoutMs: 0 });
    const closed = timeout();
    closed.timer.close();
    await sleep(T * 2);
    off.timer.close();
    assert.equal(off.fired.length, 0);
    assert.equal(closed.fired.length, 0);
  });
});
