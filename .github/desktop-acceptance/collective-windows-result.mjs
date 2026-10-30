import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativePrivatePathResult(metadata, tap, expectedSource) {
  assert.match(expectedSource, /^[a-f0-9]{40}$/);
  assert.equal(metadata.source, expectedSource, 'Source must match the reviewed commit');
  assert.equal(metadata.platform, 'win32', 'A different OS cannot provide native Windows evidence');
  assert.equal(metadata.elevated, true, 'The untrusted-owner test requires an elevated runner');
  assert.equal(metadata.trackedSourceClean, true, 'Tests must preserve the checked-out source');
  assert.equal(metadata.exitCode, 0, 'Native tests must exit successfully');
  assert.ok(Number.isFinite(metadata.elapsedMs) && metadata.elapsedMs >= 0);
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `Expected one complete TAP ${name} total`);
    counts[name] = Number(matches[0][1]);
  }
  assert.deepEqual(counts, { tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  return { ...metadata, status: 'passed', scope: 'reviewed-source-only; not packaged Desktop acceptance', counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [metadataPath, tapPath, outputPath, expectedSource] = process.argv.slice(2);
  let result;
  try {
    result = nativePrivatePathResult(
      JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
      fs.readFileSync(tapPath, 'utf8'),
      expectedSource,
    );
  } catch (error) {
    result = { status: 'failed', scope: 'reviewed-source-only', error: String(error) };
    process.exitCode = 1;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}
