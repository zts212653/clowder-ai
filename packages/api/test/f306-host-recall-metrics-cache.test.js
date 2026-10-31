import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { clearRecallMetricsCache, RecallMetricsReader } from '../dist/domains/memory/RecallMetricsReader.js';

// Keep the real reader/executor boundary and control only process completion.
// Actual readonly SQLite, cancellation and PID exit remain in the isolation suite.
function controlledProcesses(t) {
  const jobs = [];
  t.mock.method(childProcess, 'fork', () => {
    const child = new EventEmitter();
    let exited = false;
    child.kill = () => {
      if (!exited) {
        exited = true;
        child.emit('exit', null);
      }
      return true;
    };
    child.send = ({ input }, callback) => {
      jobs.push({
        succeed(totalEvents) {
          child.emit('message', {
            ok: true,
            value: {
              period: { days: input.query.days, fromMs: input.toMs - input.query.days * 86_400_000, toMs: input.toMs },
              filters: { catId: input.query.catId, toolName: input.query.toolName },
              totalEvents,
            },
          });
        },
        fail() {
          child.emit('message', { ok: false, error: { name: 'Error', message: 'controlled computation failure' } });
        },
        child,
      });
      callback(null);
    };
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const job of jobs) job.child.kill();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return jobs;
}

const query = { days: 30, catId: 'codex61-sol', toolName: 'cat_cafe_search_evidence' };
const signal = () => new AbortController().signal;

for (const refresh of [false, true]) {
  test(`a late older same-key miss cannot replace a newer ${refresh ? 'refresh' : 'normal'} result`, async (t) => {
    const jobs = controlledProcesses(t);
    const reader = new RecallMetricsReader('/owned/fixture.sqlite');
    const older = reader.read(query, signal());
    const newer = reader.read(query, signal(), refresh);
    assert.equal(jobs.length, 2, 'same-key callers retain independent process jobs');
    jobs[1].succeed(2);
    assert.equal((await newer).totalEvents, 2);
    jobs[0].succeed(1);
    assert.equal((await older).totalEvents, 1, 'the original caller still receives its own snapshot');
    assert.equal((await reader.read(query, signal())).totalEvents, 2, 'the cached snapshot must not move backward');
    assert.equal(jobs.length, 2);
  });
}

test('a later successful refresh replaces an earlier cached completion', async (t) => {
  const jobs = controlledProcesses(t);
  const reader = new RecallMetricsReader('/owned/fixture.sqlite');
  const older = reader.read(query, signal());
  const newer = reader.read(query, signal(), true);
  jobs[0].succeed(1);
  await older;
  assert.equal((await reader.read(query, signal())).totalEvents, 1);
  jobs[1].succeed(2);
  await newer;
  assert.equal((await reader.read(query, signal())).totalEvents, 2);
  assert.equal(jobs.length, 2);
});

for (const cancel of [false, true]) {
  test(`a newer ${cancel ? 'cancelled' : 'failed'} private refresh does not discard an older success`, async (t) => {
    const jobs = controlledProcesses(t);
    const reader = new RecallMetricsReader('/owned/fixture.sqlite');
    const older = reader.read(query, signal());
    const controller = new AbortController();
    const newer = assert.rejects(reader.read(query, controller.signal, true), /controlled/);
    if (cancel) controller.abort(new Error('controlled caller cancellation'));
    else jobs[1].fail();
    await newer;
    jobs[0].succeed(1);
    await older;
    assert.equal((await reader.read(query, signal())).totalEvents, 1);
    assert.equal(jobs.length, 2, 'one caller failure leaves the other result reusable');
  });
}

test('same-key ordering survives eviction while an older job remains pending', async (t) => {
  const jobs = controlledProcesses(t);
  const reader = new RecallMetricsReader('/owned/fixture.sqlite');
  const older = reader.read(query, signal());
  const newer = reader.read(query, signal(), true);
  jobs[1].succeed(2);
  await newer;
  for (let index = 0; index < 20; index++) {
    const other = reader.read({ days: 30, catId: `other-${index}` }, signal());
    jobs.at(-1).succeed(index);
    await other;
  }
  jobs[0].succeed(1);
  await older;
  const afterEviction = reader.read(query, signal());
  assert.equal(jobs.length, 23, 'a stale completion cannot repopulate the evicted key');
  jobs.at(-1).succeed(3);
  assert.equal((await afterEviction).totalEvents, 3);
});

test('global clear prevents in-flight reports from repopulating a new cache generation', async (t) => {
  const jobs = controlledProcesses(t);
  const reader = new RecallMetricsReader('/owned/fixture.sqlite');
  const older = reader.read(query, signal());
  clearRecallMetricsCache();
  const newer = reader.read(query, signal(), true);
  jobs[1].succeed(2);
  await newer;
  jobs[0].succeed(1);
  await older;
  assert.equal((await reader.read(query, signal())).totalEvents, 2);
  assert.equal(jobs.length, 2);
});

test('completion order for another key cannot fence a legitimate same-key result', async (t) => {
  const jobs = controlledProcesses(t);
  const reader = new RecallMetricsReader('/owned/fixture.sqlite');
  const first = reader.read(query, signal());
  const otherQuery = { ...query, catId: 'another-cat' };
  const second = reader.read(otherQuery, signal());
  jobs[1].succeed(2);
  await second;
  jobs[0].succeed(1);
  await first;
  assert.equal((await reader.read(query, signal())).totalEvents, 1);
  assert.equal((await reader.read(otherQuery, signal())).totalEvents, 2);
  assert.equal(jobs.length, 2);
});
