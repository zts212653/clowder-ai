import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const { spawnCli } = await import('../dist/utils/cli-spawn.js');
const { getCliExecutionExit } = await import('../dist/utils/CliExecutionObservation.js');
const { CliExitOutputDrain } = await import('../dist/utils/CliExitOutputDrain.js');

test('post-exit buffer overflow is an explicit bounded error, never silent output loss', async () => {
  const source = new PassThrough();
  const drain = new CliExitOutputDrain(source);
  const failed = new Promise((resolve) => drain.stream.once('error', resolve));
  try {
    drain.start();
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let n = 0; n < 65; n++) source.write(chunk);
    assert.match((await failed).message, /^cli_post_exit_output_limit_exceeded$/);
  } finally {
    drain.dispose();
    source.destroy();
  }
});

for (const outputMode of ['ndjson', 'plainText']) {
  test(`exited CLI with inherited open pipes completes boundedly (${outputMode})`, async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = null;
    let signals = 0;
    child.kill = () => {
      signals++;
      return true;
    };
    const events = [];
    let finished = false;
    const owner = {
      executionId: `p-${outputMode}`,
      invocationId: `c-${outputMode}`,
      threadId: 't',
      userId: 'u',
      catId: 'opus5',
    };
    const consume = (async () => {
      for await (const e of spawnCli(
        {
          command: 'fixture',
          args: [],
          timeoutMs: 0,
          outputMode,
          invocationId: owner.invocationId,
          env: {
            CAT_CAFE_EXECUTION_ID: owner.executionId,
            CAT_CAFE_INVOCATION_ID: owner.invocationId,
            CAT_CAFE_THREAD_ID: owner.threadId,
            CAT_CAFE_USER_ID: owner.userId,
            CAT_CAFE_CAT_ID: owner.catId,
          },
        },
        {
          spawnFn: () => child,
          exitDrainGraceMs: 20,
        },
      ))
        events.push(e);
      finished = true;
    })();
    child.stdout.write(outputMode === 'ndjson' ? '{"type":"result","subtype":"success"}\n' : 'finished');
    child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const finishedWithinGrace = finished;
    // Release the fixture even on RED, so the failure does not strand the test runner.
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    await consume;
    assert.ok(getCliExecutionExit(owner)?.exitedAt, 'native spawn producer must bind exact execution exit evidence');
    assert.equal(getCliExecutionExit({ ...owner, userId: 'foreign' }), undefined);
    assert.equal(finishedWithinGrace, true, 'OS exit must not wait forever for inherited stdio');
    assert.equal(signals, 0, 'never signal an exited PID');
    assert.ok(events.length > 0, 'preserve output already received');
    assert.equal(
      events.some((e) => e.__cliTimeout || e.__cliError),
      false,
    );
  });
}

test('post-exit drain preserves buffered output even when its consumer is slower than the grace', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = null;
  child.kill = () => true;
  const received = [];
  const consume = (async () => {
    for await (const event of spawnCli(
      { command: 'fixture', args: [], timeoutMs: 0 },
      { spawnFn: () => child, exitDrainGraceMs: 20 },
    )) {
      received.push(event);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
  })();
  child.stdout.write('{"n":1}\n{"n":2}\n{"n":3}\n');
  child.emit('exit', 0, null);
  await consume;
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
  assert.deepEqual(received, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('real exited process cannot be held hostage by a descendant retaining its stdout', async () => {
  let child;
  let closed;
  let signals = 0;
  const started = Date.now();
  const output = [];
  for await (const event of spawnCli(
    {
      command: process.execPath,
      timeoutMs: 0,
      args: [
        '-e',
        "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:['ignore',1,2]});process.stdout.write(JSON.stringify({type:'result',subtype:'success'})+'\\n');process.exit(0)",
      ],
    },
    {
      exitDrainGraceMs: 25,
      spawnFn: (command, args, options) => {
        child = spawn(command, args, options);
        closed = new Promise((resolve) => child.once('close', resolve));
        const original = child.kill.bind(child);
        child.kill = (signal) => {
          signals++;
          return original(signal);
        };
        return child;
      },
    },
  ))
    output.push(event);
  const elapsed = Date.now() - started;
  await closed;
  assert.ok(elapsed < 1200, `drain took ${elapsed}ms, apparently waited for descendant`);
  assert.equal(signals, 0);
  assert.deepEqual(output, [{ type: 'result', subtype: 'success' }]);
});
