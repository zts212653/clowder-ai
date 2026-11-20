import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { harness } from './helpers/event-loop-tripwire-harness.js';

async function diskReports(folder) {
  const files = (await readdir(folder)).filter((file) => /^event-loop-tripwire\..*\.ndjson$/u.test(file));
  const rows = await Promise.all(files.map((file) => readFile(`${folder}/${file}`, 'utf8')));
  return rows.flatMap((body) => body.split('\n').slice(0, -1).filter(Boolean).map(JSON.parse));
}

test('one sampling window covers repeated real blockers without a start per stall', { timeout: 10000 }, async (t) => {
  const h = await harness(t, 'retained-window');
  for (const id of ['first-pair', 'second-pair']) {
    h.child.send({ type: 'pair', id, gap: 200 });
    await h.wait((message) => message.type === 'pair-done' && message.id === id);
    if (id === 'first-pair') await delay(150);
  }
  const starts = h.messages.filter((message) => message.entry?.method === 'Profiler.start');
  assert.equal(starts.length, 1, 'recovering from each stall must not pay another heap-sized Profiler.start');
  // pair-done IPC can overtake the log mirror forwarded by the recovering main thread.
  const onsets = (await diskReports(h.folder)).filter((report) => report.phase === 'onset');
  assert.ok(onsets.length >= 4, 'independent onset records must already be durable in the open window');
  await h.wait(() => h.reports().filter((report) => report.phase === 'complete').length >= 4);
  const completed = h.reports().filter((report) => report.phase === 'complete');
  assert.ok(
    completed.every((report) => report.attribution === 'sampled'),
    JSON.stringify(completed),
  );
  assert.ok(completed.every((report) => report.topFrames.length > 0));
  assert.ok(
    completed.every((report) => report.uncoveredMs < 50),
    'the retained profile covers each blocker through recovery',
  );
});

test('a long JS stall leaves sampled code on disk before an eight-second hard exit', { timeout: 15000 }, async (t) => {
  const h = await harness(t, 'long-window');
  const enteredAt = Date.now();
  // Only the parent can terminate this intentionally long-running owned child.
  h.child.send({ type: 'block', id: 'never-recovers', ms: Number.MAX_SAFE_INTEGER, native: 'unicode' });
  await delay(8000);
  const beforeKill = await diskReports(h.folder);
  assert.equal(h.child.exitCode, null, 'the evidence is read while the owned main thread is still stuck');
  h.child.kill('SIGKILL');
  await h.exited;
  const sampled = beforeKill.filter((row) => row.phase === 'ongoing' && row.attribution === 'sampled');
  t.diagnostic(
    JSON.stringify({
      observedBeforeHardExitMs: Date.now() - enteredAt,
      phases: beforeKill.map(({ phase, attribution, reason }) => ({ phase, attribution, reason })),
      sampledFrames: sampled.flatMap((row) => row.topFrames),
    }),
  );
  assert.ok(
    sampled.some((row) => row.topFrames.some((frame) => frame.file === 'utils/json-unicode.js')),
    'a sustained API JS blocker needs a durable sampled coordinate before the process can be killed',
  );
});

test(
  'completed pre-gap code survives a later whole-process pause in the same window',
  { timeout: 10000 },
  async (t) => {
    const h = await harness(t, 'long-window');
    h.child.send({ type: 'block', id: 'pre-gap', ms: 450, native: 'unicode' });
    await h.wait((message) => message.type === 'done' && message.id === 'pre-gap');
    const recovered = await h.wait((message) => message.entry?.phase === 'recovered');
    h.child.kill('SIGSTOP');
    try {
      await delay(1200);
    } finally {
      h.child.kill('SIGCONT');
    }
    await h.wait((message) => message.entry?.kind === 'event_loop_observer_gap');
    h.child.send({ type: 'close-observer' });
    await h.wait((message) => message.type === 'closed-observer');
    const rows = await diskReports(h.folder);
    const completed = rows.find((row) => row.episode === recovered.entry.episode && row.phase === 'complete');
    assert.ok(completed, 'the completed blocker must be published');
    assert.equal(completed.attribution, 'sampled', JSON.stringify(completed));
    assert.ok(completed.topFrames.some((frame) => frame.file === 'utils/json-unicode.js'));
    const gaps = rows.filter((row) => row.kind === 'event_loop_observer_gap');
    assert.equal(gaps.length, 1);
    assert.ok(gaps.every((row) => row.attribution === 'unknown' && row.topFrames.length === 0));
  },
);
