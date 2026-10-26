import assert from 'node:assert/strict';
import inspector from 'node:inspector';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const { recordProcessCpuProfile } = await import('../dist/infrastructure/telemetry/cpu/process-cpu-session.js');
const { tryAcquireCpuProfiler } = await import('../dist/infrastructure/telemetry/cpu/cpu-profiler-lease.js');
const { projectProcessCpuProfile } = await import('../dist/infrastructure/telemetry/cpu/process-cpu-profile.js');
const { codeCoordinate } = await import('../dist/infrastructure/telemetry/cpu/cpu-code-coordinate.js');

test('real internal V8 Session under tsx preserves API ancestry and leaves no debugger listener', async () => {
  assert.equal(inspector.url(), undefined);
  const release = tryAcquireCpuProfiler();
  assert.equal(typeof release, 'function');
  let result;
  try {
    const capture = recordProcessCpuProfile(new AbortController().signal, 250);
    await setImmediate();
    const root = new URL('../dist/', import.meta.url).href;
    const nodes = Array.from({ length: 5000 }, (_, i) => ({
      id: i + 1,
      children: i === 4999 ? [] : [i + 2],
      callFrame: {
        url: `${root}infrastructure/fixture.js`,
        functionName: 'fixture',
        scriptId: '1',
        lineNumber: 0,
        columnNumber: 0,
      },
    }));
    const workload = { nodes, samples: Array(5000).fill(5000), startTime: 0, endTime: 1000 };
    const until = performance.now() + 350;
    while (performance.now() < until) {
      projectProcessCpuProfile(workload);
      await setImmediate();
    }
    result = await capture;
  } finally {
    release();
  }
  assert.equal(result.status, 'sampled');
  assert.equal(inspector.url(), undefined);
  const summary = projectProcessCpuProfile(result.profile);
  assert.equal(summary.omittedNodes, 0);
  assert.equal(summary.omittedParentEdges, 0);
  assert.ok(summary.samplesWithApiCaller > 0, 'real profiler must see a trusted API caller');

  // Independent slow oracle walks original parent chains per sample, rather than using the production forest fold.
  const nodes = new Map(result.profile.nodes.map((n) => [n.id, n]));
  const parents = new Map();
  for (const n of nodes.values())
    for (const child of n.children ?? []) {
      assert.ok(!parents.has(child) || parents.get(child) === n.id);
      parents.set(child, n.id);
    }
  const expected = new Map();
  const keyOf = (c) => `${c.file}:${c.line}:${c.function}`;
  const get = (c) => {
    const key = keyOf(c);
    if (!expected.has(key))
      expected.set(key, { selfSamples: 0, nativeSamples: 0, apiCallerSamples: 0, inclusiveSamples: 0 });
    return expected.get(key);
  };
  for (const id of result.profile.samples ?? []) {
    const leaf = nodes.get(id)?.callFrame;
    if (leaf?.functionName === '(idle)' || leaf?.functionName === '(garbage collector)') continue;
    const chain = [];
    for (let at = id; at !== undefined; at = parents.get(at)) {
      const c = codeCoordinate(nodes.get(at)?.callFrame);
      if (c) chain.push(c);
    }
    const self = codeCoordinate(leaf);
    if (self) get(self).selfSamples++;
    if (chain.length) {
      get(chain[0]).apiCallerSamples++;
      if (leaf && !leaf.url) get(chain[0]).nativeSamples++;
      const seen = new Set();
      for (const c of chain)
        if (!seen.has(keyOf(c))) {
          seen.add(keyOf(c));
          get(c).inclusiveSamples++;
        }
    }
  }
  for (const frame of summary.topFrames) {
    const { selfSamples, nativeSamples, apiCallerSamples, inclusiveSamples } = frame;
    assert.deepEqual({ selfSamples, nativeSamples, apiCallerSamples, inclusiveSamples }, expected.get(keyOf(frame)));
  }
  // Exercise a new TS dynamic import after internal disconnect, with tsx active.
  assert.equal(
    typeof (await import('../src/infrastructure/telemetry/cpu/cpu-code-coordinate.ts')).codeCoordinate,
    'function',
  );
  console.log(
    JSON.stringify({
      kind: 'owned_real_v8_witness',
      samples: summary.sampleCount,
      withCaller: summary.samplesWithApiCaller,
      unknown: summary.samplesWithoutApiCaller,
      profileElapsedMs: summary.profileElapsedMs,
      oracleMatches: summary.topFrames.length,
      inspectorListener: false,
      rawPersisted: false,
    }),
  );
});
