import assert from 'node:assert/strict';
import { test } from 'node:test';

const { projectMainThreadCpuProfile: project } = await import(
  '../dist/infrastructure/telemetry/cpu/main-thread-cpu-profile.js'
);
const { projectProcessCpuProfile: processProfile } = await import(
  '../dist/infrastructure/telemetry/cpu/process-cpu-profile.js'
);
const root = new URL('../dist/', import.meta.url).href;
const node = (id, url, fn, children = []) => ({
  id,
  children,
  callFrame: { url, functionName: fn, scriptId: '1', lineNumber: 7, columnNumber: 0 },
});
const api = (id, fn, children) => node(id, `${root}infrastructure/${fn}.js`, fn, children);
const profile = (nodes, samples) => ({ nodes, samples, startTime: 0, endTime: 60000000 });

test('process evidence includes API ancestors of node/external/native leaves without recursive double counting', () => {
  const result = processProfile(
    profile(
      [
        api(1, 'outer', [2]),
        api(2, 'inner', [3, 4, 5, 6]),
        node(3, 'node:fs', 'readFileSync'),
        node(4, 'file:///private-canary/node_modules/zod/index.js', 'private-canary'),
        node(5, '', 'JSON.parse'),
        node(6, '', '(idle)'),
      ],
      [2, 3, 3, 4, 5, 6],
    ),
  );
  const inner = result.topFrames.find((f) => f.function === 'inner');
  const outer = result.topFrames.find((f) => f.function === 'outer');
  assert.equal(inner?.selfSamples, 1);
  assert.equal(inner?.apiCallerSamples, 5);
  assert.equal(inner?.inclusiveSamples, 5);
  assert.equal(inner?.nativeSamples, 1);
  assert.equal(outer?.inclusiveSamples, 5);
  assert.equal(outer?.apiCallerSamples, 0);
  assert.equal(result.samplesWithApiCaller, 5);
  assert.equal(result.samplesWithoutApiCaller, 0);
  const recursive = processProfile(
    profile([api(1, 'same', [2]), api(2, 'same', [3]), node(3, 'node:fs', 'read')], [3, 3]),
  );
  assert.equal(recursive.topFrames.length, 1);
  assert.equal(recursive.topFrames[0].inclusiveSamples, 2, 'recursive coordinate participates once per sample');
  assert.doesNotMatch(JSON.stringify(result), /private-canary|file:\/\/|scriptId|columnNumber/);
});

test('long process mode keeps a 5000-node API caller chain without changing legacy limits', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => node(i + 1, '', 'native', i === 4999 ? [] : [i + 2]));
  nodes[0] = api(1, 'caller', [2]);
  const p = profile(nodes, Array(12000).fill(5000));
  const result = processProfile(p);
  assert.equal(result.omittedNodes, 0);
  assert.equal(result.omittedSamples, 0);
  assert.equal(result.nativeSamplesWithApiCaller, 12000);
  assert.equal(result.topFrames[0].inclusiveSamples, 12000);
  const legacy = project(p);
  assert.equal(legacy.omittedNodes, 904);
  assert.equal(legacy.retainedSamples, 10000);
});

test('ambiguous, missing and cyclic parents never invent inclusive or nearest callers', () => {
  for (const nodes of [
    [api(1, 'a', [3]), api(2, 'b', [3]), node(3, 'node:fs', 'read')],
    [api(1, 'a', [2]), node(2, '', 'native', [1])],
    [api(1, 'a', [999])],
  ]) {
    const id = nodes.length === 3 ? 3 : nodes.length === 2 ? 2 : 999;
    const result = processProfile(profile(nodes, [id]));
    assert.equal(result.samplesWithApiCaller, 0);
    assert.equal(result.samplesWithoutApiCaller, 1);
    assert.equal(
      result.topFrames.reduce((n, f) => n + f.inclusiveSamples, 0),
      0,
    );
  }
});

test('process projection bounds nodes/samples/edges and truncation fails caller attribution closed', () => {
  const nodes = Array.from({ length: 65537 }, (_, i) => api(i + 1, 'bounded', []));
  nodes[0].children = Array(131073).fill(2);
  const result = processProfile(profile(nodes, Array(100001).fill(2)));
  assert.equal(result.retainedSamples, 100000);
  assert.equal(result.omittedSamples, 1);
  assert.equal(result.omittedNodes, 1);
  assert.equal(result.omittedParentEdges, 1);
  assert.equal(result.samplesWithApiCaller, 0);
  assert.equal(result.samplesWithoutApiCaller, 100000);
  assert.ok(result.topFrames.length <= 24);
  assert.ok(JSON.stringify(result).length < 12000);
});

test('inclusive and nearest counts match an independent oracle on 300 seeded recursive trees', () => {
  let seed = 229;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 300; trial++) {
    const nodes = [node(1, '', '(root)')];
    const parents = new Map();
    for (let id = 2; id <= 40; id++) {
      const parent = 1 + random(id - 1);
      parents.set(id, parent);
      nodes[parent - 1].children.push(id);
      const kind = random(5);
      nodes.push(
        kind === 0
          ? api(id, `fn${random(4)}`, [])
          : kind === 1
            ? node(id, 'node:fs', 'read')
            : kind === 2
              ? node(id, '', 'JSON.parse')
              : kind === 3
                ? node(id, 'file:///external.js', 'lib')
                : node(id, '', '(idle)'),
      );
    }
    const samples = Array.from({ length: 100 }, () => 1 + random(40));
    const expected = new Map();
    const get = (fn) => {
      if (!expected.has(fn))
        expected.set(fn, { selfSamples: 0, nativeSamples: 0, apiCallerSamples: 0, inclusiveSamples: 0 });
      return expected.get(fn);
    };
    for (const id of samples) {
      const leaf = nodes[id - 1].callFrame;
      if (leaf.functionName === '(idle)') continue;
      const chain = [];
      for (let at = id; at; at = parents.get(at)) {
        const f = nodes[at - 1].callFrame;
        if (f.url.startsWith(root)) chain.push(f.functionName);
      }
      if (leaf.url.startsWith(root)) get(leaf.functionName).selfSamples++;
      if (chain.length) {
        get(chain[0]).apiCallerSamples++;
        if (!leaf.url) get(chain[0]).nativeSamples++;
        for (const fn of new Set(chain)) get(fn).inclusiveSamples++;
      }
    }
    const actual = processProfile(profile(nodes, samples));
    for (const entry of actual.topFrames) {
      const { selfSamples, nativeSamples, apiCallerSamples, inclusiveSamples } = entry;
      assert.deepEqual(
        { selfSamples, nativeSamples, apiCallerSamples, inclusiveSamples },
        expected.get(entry.function),
        `tree ${trial}/${entry.function}`,
      );
    }
    assert.equal(actual.topFrames.length, expected.size);
  }
});
