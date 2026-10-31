const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

async function start(t, mode = 'normal') {
  const child = spawn(process.execPath, [join(__dirname, 'main-stdio-fixture.cjs'), mode], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc', 'pipe'],
  });
  const telemetry = [],
    frames = [],
    errors = [];
  let reportBuffer = '',
    frameBuffer = '';
  child.stdio[4].on('data', (chunk) => {
    reportBuffer += chunk;
    const lines = reportBuffer.split('\n');
    reportBuffer = lines.pop();
    for (const line of lines) telemetry.push(JSON.parse(line));
  });
  child.stdout.on('data', (chunk) => {
    frameBuffer += chunk;
    const lines = frameBuffer.split('\n');
    frameBuffer = lines.pop();
    for (const line of lines) frames.push(JSON.parse(line));
  });
  child.stderr.on('data', (chunk) => errors.push(chunk.toString()));
  child.stdin.on('error', (error) => errors.push(error.code));
  child.on('error', (error) => errors.push(error.code));
  const closed = once(child, 'close');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4_000);
  t.after(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  const wait = async (predicate) => {
    const until = Date.now() + 2_000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, errors.join('') + JSON.stringify(telemetry));
      assert.equal(child.signalCode, null, JSON.stringify(telemetry));
      assert.ok(Date.now() < until, 'owned child did not reach the expected state');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await wait(() => telemetry.some((row) => row.kind === 'fixture-ready'));
  let id = 0;
  return {
    child,
    telemetry,
    frames,
    wait,
    async boot() {
      child.send('start', () => {});
      await wait(() => telemetry.some((row) => row.kind === 'started'));
    },
    async request(method, params = null) {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ v: 1, id: requestId, method, params })}\n`);
      await wait(() => frames.some((row) => row.id === requestId));
      return frames.find((row) => row.id === requestId);
    },
    async open() {
      const input = telemetry.find((row) => row.kind === 'fixture-ready').input;
      return this.request('open', input);
    },
    async breakOutput(name) {
      const stream = child[name];
      const closing = once(stream, 'close');
      stream.destroy();
      await closing;
    },
    async terminal(expectedCode = 0) {
      const [code, signal] = await closed;
      assert.equal(code, expectedCode, JSON.stringify(telemetry));
      assert.equal(signal, null);
      assert.equal(
        telemetry.some((row) => row.kind === 'uncaught'),
        false,
        JSON.stringify(telemetry),
      );
      const result = telemetry.find((row) => row.kind === 'terminal');
      assert.equal(result.quitCalls, expectedCode === 0 ? 1 : 0);
      assert.equal(result.exitCalls, expectedCode === 0 ? 0 : 1);
      if (result.profile) assert.equal(existsSync(result.profile), false, 'owned profile was not removed');
      return result;
    },
  };
}

test('raw main survives stderr disconnection before its first stage and preserves control replies', async (t) => {
  const f = await start(t);
  await f.breakOutput('stderr');
  await f.boot();
  assert.equal((await f.open()).ok, true);
  assert.equal((await f.request('poll')).value, 'visible');
  assert.equal((await f.request('close')).ok, true);
  assert.equal((await f.terminal()).destroyed, true);
});

test('raw main finishes an unexpected window close after the diagnostic reader disappears', async (t) => {
  const f = await start(t);
  await f.boot();
  await f.open();
  await f.breakOutput('stderr');
  f.child.send('destroy-window');
  assert.equal((await f.terminal()).destroyed, true);
});

for (const trigger of ['poll', 'bridge'])
  test(`raw main closes its private channel on real stdout loss during ${trigger}`, async (t) => {
    const f = await start(t);
    await f.boot();
    await f.open();
    await f.breakOutput('stdout');
    if (trigger === 'bridge') f.child.send('bridge');
    else f.child.stdin.write(`${JSON.stringify({ v: 1, id: 2, method: 'poll', params: null })}\n`);
    assert.equal((await f.terminal()).destroyed, true);
  });

for (const mode of ['late-ready', 'late-load'])
  test(`raw main stdin EOF closes ${mode} without a late success`, async (t) => {
    const f = await start(t, mode);
    await f.boot();
    const input = f.telemetry.find((row) => row.kind === 'fixture-ready').input;
    f.child.stdin.write(`${JSON.stringify({ v: 1, id: 1, method: 'open', params: input })}\n`);
    await f.wait(() =>
      f.telemetry.some((row) =>
        mode === 'late-ready' ? row.kind === 'waiting-ready' && row.calls >= 2 : row.kind === 'waiting-load',
      ),
    );
    f.child.stdin.end();
    await f.wait(() => f.telemetry.some((row) => row.kind === 'quit-called'));
    f.child.send(mode === 'late-ready' ? 'release-ready' : 'release-load');
    f.child.send('finish');
    const terminal = await f.terminal();
    assert.equal(terminal.windowsCreated, mode === 'late-ready' ? 0 : 1);
    if (mode === 'late-load') assert.equal(terminal.destroyed, true);
    assert.deepEqual(f.frames, [], 'terminal opening must not publish a late success');
  });

test('raw main still fails closed on invalid protocol when diagnostics are disconnected', async (t) => {
  const f = await start(t);
  await f.breakOutput('stderr');
  await f.boot();
  f.child.stdin.write('{}\n');
  await f.terminal(1);
  assert.deepEqual(f.frames, []);
});

test('raw main native app quit closes once while its diagnostic pipe is disconnected', async (t) => {
  const f = await start(t);
  await f.boot();
  await f.open();
  await f.breakOutput('stderr');
  f.child.send('native-quit');
  assert.equal((await f.terminal()).destroyed, true);
});
