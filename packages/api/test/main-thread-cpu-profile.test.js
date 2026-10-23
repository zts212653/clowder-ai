import assert from 'node:assert/strict';
import { test } from 'node:test';

const { projectMainThreadCpuProfile } = await import('../dist/infrastructure/main-thread-cpu-profile.js');
const root = new URL('../dist/', import.meta.url).href;
function node(id, url, functionName = 'retainedMediaHeads') {
  return { id, callFrame: { url, functionName, scriptId: '1', lineNumber: 41, columnNumber: 0 } };
}

test('CPU evidence preserves trusted code coordinates while dropping raw URLs and untrusted frames', () => {
  const nodes = [
    node(1, `${root}domains/video-studio/content-owner/store.js`),
    node(2, 'file:///home/user/private-url-canary.js', 'private-name-canary'),
    node(3, `${root}infrastructure/example.js`, 'invalid\nprivate-name-canary'),
    node(4, `${root}../private-path-canary.js`),
    node(5, 'node:fs'),
    node(6, '', '(idle)'),
    node(7, '', '(garbage collector)'),
  ];
  const result = projectMainThreadCpuProfile({
    nodes,
    startTime: 1000,
    endTime: 51000,
    samples: [1, 1, 2, 3, 4, 5, 6, 7],
    privateBody: 'private-body-canary',
  });
  assert.equal(result.sampleCount, 8);
  assert.equal(result.profileElapsedMs, 50);
  assert.deepEqual(result.categories, { api: 3, external: 2, node: 1, idle: 1, gc: 1, native: 0 });
  assert.deepEqual(result.topFrames[0], {
    file: 'domains/video-studio/content-owner/store.js',
    function: 'retainedMediaHeads',
    line: 42,
    selfSamples: 2,
  });
  assert.equal(result.topFrames[1].function, '<anonymous>');
  assert.doesNotMatch(JSON.stringify(result), /canary|file:\/\/|\/Users\/|privateBody|scriptId|columnNumber/);
});

test('large native profiles have explicit truncation and a fixed maximum of twelve output frames', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => node(i + 1, `${root}infrastructure/source-${i}.js`, `fn${i}`));
  const result = projectMainThreadCpuProfile({
    nodes,
    startTime: 0,
    endTime: 2000000,
    samples: Array.from({ length: 19000 }, (_, i) => (i % 5000) + 1),
  });
  assert.equal(result.retainedSamples, 10000);
  assert.equal(result.omittedSamples, 9000);
  assert.equal(result.omittedNodes, 904);
  assert.equal(result.topFrames.length, 12);
  assert.equal(
    Object.values(result.categories).reduce((a, b) => a + b, 0),
    10000,
  );
  assert.ok(JSON.stringify(result).length < 3000);
});
