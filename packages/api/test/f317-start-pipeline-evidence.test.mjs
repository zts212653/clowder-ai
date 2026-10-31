import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import streams from 'node:stream/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pluginStartFailureReport } from '../src/domains/plugin/diagnostics/plugin-start-failure.ts';
import { stageVerifiedPackageContent } from '../src/domains/plugin/external-runtime/package-staging.ts';
import { recordPackageStagingPhase } from '../src/domains/plugin/external-runtime/package-staging-diagnostics.ts';

for (const [phase, failingCall] of [
  ['copy', 1],
  ['preflight', 2],
]) {
  test(`${phase} timeout retains its trusted staging phase in the runtime start report`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'f317-start-pipeline-'));
    const artifactRoot = join(root, 'artifact');
    const packagesRoot = join(root, 'stages');
    await fs.mkdir(artifactRoot);
    await fs.mkdir(join(root, 'source', 'package'), { recursive: true });
    await fs.writeFile(join(root, 'source', 'package', 'asset.txt'), 'original fixture bytes');
    await promisify(execFile)('tar', ['-czf', 'artifact/package.tgz', '-C', 'source', 'package'], { cwd: root });
    const archive = join(artifactRoot, 'package.tgz');
    const bytes = await fs.readFile(archive);
    const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const original = streams.pipeline;
    let calls = 0;
    streams.pipeline = (...args) => {
      if (++calls === failingCall) {
        // Keep real streams, abort handling and cleanup; only force the selected
        // existing deadline to have elapsed, without waiting for thirty seconds.
        args[args.length - 1] = { signal: AbortSignal.abort(new DOMException('private deadline', 'TimeoutError')) };
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    t.after(async () => {
      streams.pipeline = original;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    });
    const error = await stageVerifiedPackageContent({
      artifactRoot,
      packagesRoot,
      packageDigest: digest,
      tarBin: 'tar',
    }).then(
      () => assert.fail('aborted archive admitted'),
      (error) => error,
    );
    assert.equal(error.code, 'PACKAGE_AUTHORITY_MISMATCH');
    assert.equal(error.cause.name, 'AbortError');
    assert.equal(error.cause.cause.name, 'TimeoutError');
    assert.equal(calls, failingCall, 'the intended real pipeline must have started');
    assert.deepEqual(await fs.readdir(packagesRoot), [], 'rejection removes all private stages');
    assert.deepEqual(await fs.readFile(archive), bytes, 'admitted archive remains untouched');
    const report = pluginStartFailureReport({
      pluginId: 'fixture',
      pluginInstanceId: 'fixture',
      phase: 'repair',
      occurredAt: 2_000,
      error,
    });
    assert.equal(report.stagingPhase, phase, 'trusted staging phase survives lifecycle report');
    assert.equal(report.category.code, 'PACKAGE_AUTHORITY_MISMATCH');
    assert.equal(JSON.stringify(report).includes('private deadline'), false);
    assert.equal(JSON.stringify(report).includes(digest), false);
  });
}

test('untrusted phase properties and unrecognized Host metadata cannot forge a staging diagnosis', () => {
  const error = new Error('private fixture');
  for (const key of ['stagingPhase', 'phase'])
    Object.defineProperty(error, key, {
      get() {
        throw new Error('secret');
      },
    });
  for (const candidate of [error, recordPackageStagingPhase(new Error('private fixture'), 'SECRET_UNKNOWN_PHASE')]) {
    const report = pluginStartFailureReport({
      pluginId: 'fixture',
      pluginInstanceId: 'fixture',
      phase: 'repair',
      occurredAt: 2_000,
      error: candidate,
    });
    assert.equal('stagingPhase' in report, false);
    assert.equal(JSON.stringify(report).includes('SECRET_UNKNOWN_PHASE'), false);
  }
});
