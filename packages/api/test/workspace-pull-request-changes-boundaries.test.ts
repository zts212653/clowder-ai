import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseSha,
  comparison,
  file,
  fixture,
  headSha,
  mergeBaseSha,
  metadata,
} from './helpers/workspace-pull-request-changes-fixture.js';

const largeFiles = () =>
  Array.from({ length: 100 }, (_, index) =>
    file(`src/file-${index}.ts`, { patch: `@@ -1 +1 @@\n-old\n+${'x'.repeat(24000)}` }),
  );

test('reads a comparison envelope above the rendered patch cap through the real bounded process and returns partial', async () => {
  const compare = comparison(largeFiles());
  assert.ok(Buffer.byteLength(JSON.stringify(compare)) > 2 * 1024 * 1024);
  const f = await fixture({ boundedComparison: true, pull: { ...metadata(), changed_files: 100 }, compare });
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.completeness, 'partial');
    assert.deepEqual(data.omissions, ['patch_limit']);
    assert.equal(data.changedFiles.length, 100);
    assert.ok(data.changedFiles.some((item: { patchState: string }) => item.patchState === 'available'));
    assert.ok(data.changedFiles.some((item: { patchState: string }) => item.patchState === 'unavailable'));
    assert.ok(Buffer.byteLength(data.diff) <= 2 * 1024 * 1024);
    assert.deepEqual(data.comparison, { baseSha, headSha, mergeBaseSha });
  } finally {
    await f.close();
  }
});

test('retains missing-patch and patch-limit reasons in either file order', async () => {
  for (const binaryFirst of [false, true]) {
    const binary = file('binary.png', { patch: undefined });
    const files = binaryFirst ? [binary, ...largeFiles()] : [...largeFiles(), binary];
    const f = await fixture({ pull: { ...metadata(), changed_files: 101 }, compare: comparison(files) });
    try {
      const response = await f.read();
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual([...response.json().omissions].sort(), ['missing_patch', 'patch_limit']);
    } finally {
      await f.close();
    }
  }
});

test('keeps the transport read finite and reports an oversized envelope as unavailable, with no local fallback', async () => {
  const f = await fixture({
    boundedComparison: true,
    compare: comparison([file('large.ts', { patch: `@@ -1 +1 @@\n-old\n+${'x'.repeat(17 * 1024 * 1024)}` })]),
  });
  try {
    const response = await f.read();
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'unavailable');
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});
