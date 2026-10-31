import assert from 'node:assert/strict';
import { test } from 'node:test';

const moduleUrl = new URL(
  process.env.TASK229_CPU_PROJECTOR ?? '../dist/infrastructure/telemetry/cpu/main-thread-cpu-profile.js',
  import.meta.url,
);
const { projectMainThreadCpuProfile } = await import(moduleUrl.href);
const root = new URL('../../../', moduleUrl).href;
const node = (id, url, name, children = []) => ({
  id,
  callFrame: { url, functionName: name, scriptId: '1', lineNumber: 6, columnNumber: 0 },
  children,
});
const profile = (nodes, samples) => ({ nodes, samples, startTime: 1000, endTime: 51000 });

test('native leaves retain their nearest safe API ancestor while self sample counts stay exact', () => {
  const result = projectMainThreadCpuProfile(
    profile(
      [
        node(1, '', '(root)', [2, 7]),
        node(2, `${root}infrastructure/outer.js`, 'outer', [3]),
        node(3, `${root}infrastructure/inner.js`, 'load', [4]),
        node(4, 'node:fs', 'nodeWrapper', [5, 6]),
        node(5, '', 'private-native-canary'),
        node(6, '', 'another-private-canary'),
        node(7, `${root}infrastructure/other.js`, 'other', [8]),
        node(8, '', 'native'),
      ],
      [5, 5, 6, 8, 1, 3],
    ),
  );
  assert.deepEqual(result.categories, { api: 1, node: 0, external: 0, idle: 0, gc: 0, native: 5 });
  assert.equal(result.nativeSamplesWithApiCaller, 4);
  assert.equal(result.nativeSamplesWithoutApiCaller, 1);
  assert.deepEqual(result.topFrames[0], {
    file: 'infrastructure/inner.js',
    function: 'load',
    line: 7,
    selfSamples: 1,
    nativeSamples: 3,
  });
  assert.equal(
    result.topFrames.some((f) => f.file === 'infrastructure/outer.js'),
    false,
  );
  assert.doesNotMatch(JSON.stringify(result), /canary|file:\/\/|scriptId|columnNumber/);
});

test('native ancestor evidence preserves path and function redaction across external frames', () => {
  const result = projectMainThreadCpuProfile(
    profile(
      [
        node(1, `${root}infrastructure/safe.js`, 'invalid\nprivate-function-canary', [2]),
        node(2, 'file:///home/user/path-canary.js', 'private-external-canary', [3]),
        node(3, '', 'private-native-canary'),
      ],
      [3, 3],
    ),
  );
  assert.equal(result.nativeSamplesWithApiCaller, 2);
  assert.deepEqual(result.topFrames, [
    { file: 'infrastructure/safe.js', function: '<anonymous>', line: 7, selfSamples: 0, nativeSamples: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /canary|file:\/\/|\/Users\/|children|scriptId/);
});

test('missing, cyclic and truncated ancestor chains stay explicit and cannot invent an API caller', () => {
  const nodes = [node(1, '', 'native', [2]), node(2, '', 'native', [1]), node(3, '', 'native')];
  for (let id = 4; id <= 4096; id++) nodes.push(node(id, '', 'native'));
  nodes.push(node(4097, `${root}infrastructure/truncated.js`, 'outsideRetainedNodes', [3]));
  const result = projectMainThreadCpuProfile(profile(nodes, [1, 2, 3]));
  assert.equal(result.omittedNodes, 1);
  assert.equal(result.nativeSamplesWithApiCaller, 0);
  assert.equal(result.nativeSamplesWithoutApiCaller, 3);
  assert.deepEqual(result.topFrames, []);
});

test('native ancestors share the original twelve-location and ten-thousand-sample output budgets', () => {
  const nodes = Array.from({ length: 24 }, (_, i) =>
    i % 2 === 0
      ? node(i + 1, `${root}infrastructure/caller-${i}.js`, `caller${i}`, [i + 2])
      : node(i + 1, '', 'private-native-canary'),
  );
  const result = projectMainThreadCpuProfile(
    profile(
      nodes,
      Array.from({ length: 11000 }, (_, i) => 2 * (i % 12) + 2),
    ),
  );
  assert.equal(result.nativeSamplesWithApiCaller, 10000);
  assert.equal(result.nativeSamplesWithoutApiCaller, 0);
  assert.equal(result.retainedSamples, 10000);
  assert.equal(result.omittedSamples, 1000);
  assert.equal(result.topFrames.length, 12);
  assert.equal(
    result.topFrames.reduce((n, f) => n + f.nativeSamples, 0),
    10000,
  );
  assert.equal(
    result.topFrames.every((f) => f.selfSamples === 0),
    true,
  );
  assert.ok(JSON.stringify(result).length < 3000);
});

test('ambiguous parents and cycles containing API frames cannot invent an API caller', () => {
  for (const nodes of [
    [
      node(1, `${root}infrastructure/first.js`, 'first', [3]),
      node(2, `${root}infrastructure/second.js`, 'second', [3]),
      node(3, '', 'native'),
    ],
    [node(1, `${root}infrastructure/cycle.js`, 'cycle', [3]), node(3, '', 'native', [1])],
  ]) {
    const result = projectMainThreadCpuProfile(profile(nodes, [3, 3]));
    assert.equal(result.nativeSamplesWithApiCaller, 0);
    assert.equal(result.nativeSamplesWithoutApiCaller, 2);
    assert.deepEqual(result.topFrames, []);
  }

  const duplicateEdge = projectMainThreadCpuProfile(
    profile([node(1, `${root}infrastructure/safe.js`, 'safe', [2, 2]), node(2, '', 'native')], [2]),
  );
  assert.equal(duplicateEdge.nativeSamplesWithApiCaller, 1);
});

test('parent-edge indexing is bounded and incomplete edges cannot hide an ambiguous caller', () => {
  let indexed = 0;
  const children = new Proxy([2, ...Array(4096).fill(9000)], {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) indexed++;
      return Reflect.get(target, key, receiver);
    },
  });
  const result = projectMainThreadCpuProfile(
    profile(
      [
        node(1, `${root}infrastructure/first.js`, 'first', children),
        node(2, '', 'native'),
        node(3, `${root}infrastructure/second.js`, 'second', [2]),
      ],
      [2],
    ),
  );
  assert.ok(indexed <= 4096);
  assert.equal(result.omittedParentEdges, 2);
  assert.equal(result.nativeSamplesWithApiCaller, 0);
  assert.equal(result.nativeSamplesWithoutApiCaller, 1);
  assert.deepEqual(result.topFrames, []);
});

test('deep native stacks resolve without recursion and reuse caller evidence across samples', () => {
  const nodes = Array.from({ length: 4096 }, (_, i) =>
    node(i + 1, i === 0 ? `${root}infrastructure/root.js` : '', i === 0 ? 'caller' : 'native', i < 4095 ? [i + 2] : []),
  );
  const result = projectMainThreadCpuProfile(profile(nodes, Array(10000).fill(4096)));
  assert.equal(result.nativeSamplesWithApiCaller, 10000);
  assert.equal(result.nativeSamplesWithoutApiCaller, 0);
  assert.deepEqual(result.topFrames, [
    { file: 'infrastructure/root.js', function: 'caller', line: 7, selfSamples: 0, nativeSamples: 10000 },
  ]);
});
