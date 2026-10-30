import assert from 'node:assert/strict';
import test from 'node:test';
import { nativePrivatePathResult } from './collective-windows-result.mjs';

const source = 'd522df44a3b6e8ef59f5085c8c6d88b227cf0455';
const metadata = {
  source,
  platform: 'win32',
  elevated: true,
  trackedSourceClean: true,
  exitCode: 0,
  elapsedMs: 2500,
};
const passed = '# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const skipped = '# tests 5\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 5\n# todo 0\n';

test('a real Windows pass retains exact source and five executed outcomes', () => {
  const result = nativePrivatePathResult(metadata, passed, source);
  assert.equal(result.status, 'passed');
  assert.equal(result.source, source);
  assert.equal(result.counts.pass, 5);
});

test('exit-zero macOS skips are not native Windows evidence', () => {
  assert.throws(() => nativePrivatePathResult({ ...metadata, platform: 'darwin' }, skipped, source));
  assert.throws(() => nativePrivatePathResult(metadata, skipped, source));
});

test('missing elevation, wrong source or a dirty checkout cannot certify the reviewed source', () => {
  for (const change of [{ elevated: false }, { source: 'a'.repeat(40) }, { trackedSourceClean: false }]) {
    assert.throws(() => nativePrivatePathResult({ ...metadata, ...change }, passed, source));
  }
});

test('a partial, failed or missing run cannot become a complete pass', () => {
  for (const tap of [
    passed.replace('# tests 5', '# tests 4'),
    passed.replace('# fail 0', '# fail 1'),
    '',
    passed + passed,
  ]) {
    assert.throws(() => nativePrivatePathResult(metadata, tap, source));
  }
  assert.throws(() => nativePrivatePathResult({ ...metadata, exitCode: 1 }, passed, source));
});
