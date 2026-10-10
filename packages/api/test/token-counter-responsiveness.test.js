import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// One regex piece, unlike the existing space-separated ASCII benchmark. Run in
// an owned child so a regression cannot block the test runner for minutes.
test('long Chinese token counting does not monopolize the event loop', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { performance } from 'node:perf_hooks';
       import { estimateTokens } from './dist/utils/token-counter.js';
       estimateTokens('warmup');
       const start = performance.now();
       setTimeout(() => {
         console.log(JSON.stringify({ tokens, lagMs: performance.now() - start }));
       }, 0);
       const tokens = estimateTokens('验收填充文字'.repeat(2000));`,
    ],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.error, undefined, `token counter blocked: ${child.error}`);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.ok(result.tokens > 0);
  assert.ok(result.lagMs < 500, `blocked the event loop for ${result.lagMs}ms`);
});
