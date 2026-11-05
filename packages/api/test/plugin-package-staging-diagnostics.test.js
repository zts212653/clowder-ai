import assert from 'node:assert/strict';
import childProcess, { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const childScript = String.raw`
import { createHash } from 'node:crypto';
import { harness, catalogEntry } from './test/plugin-official-package-installer.fixture.js';
import { OfficialPluginPackageInstaller } from './dist/domains/plugin/official-package-installer.js';
import { logger } from './dist/infrastructure/logger.js';
const bytes = Buffer.from('invalid gzip fixture; archive contents must not be logged');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const fixture = await harness({ bytes, integrity });
const { packagesRoot, inventory } = fixture;
let installer = fixture.installer;
const earlyFailure = process.argv[1] === 'admission';
if (earlyFailure) {
  const blocked = packagesRoot + '/not-a-directory';
  await (await import('node:fs/promises')).writeFile(blocked, 'fixture');
  installer = new OfficialPluginPackageInstaller({
    inventory, packagesRoot: blocked, catalog: [catalogEntry(integrity)], fetchArchive: async () => bytes,
  });
}
try {
  await installer.install('feishu-meeting-intake', { version: '0.1.0-alpha.1', packageDigest: integrity });
  throw new Error('invalid archive was admitted');
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: 'outcome', code: error.code, message: error.message,
    tarCode: error.cause?.cause?.code, stderr: error.cause?.cause?.stderr,
    admissionCode: error.cause?.code }) + '\n');
} finally {
  // On Windows the rejected staging directory may be temporarily locked.
  // Retry fixture cleanup only; a persistent lock must still fail the test.
  await (await import('node:fs/promises')).rm(packagesRoot, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  });
}
logger.flush();
`;

for (const phase of ['preflight', 'admission']) {
  test(`archive rejection retains ${phase} diagnostics and the existing public classification`, async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'package-staging-diagnostics-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', childScript, phase],
        {
          cwd: apiRoot,
          env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn', LOG_DIR: logDir, NPM_TOKEN: 'must-not-leak' },
          timeout: 15_000,
        },
      );
      const rows = stdout
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      const outcome = rows.find((row) => row.kind === 'outcome');
      assert.equal(outcome.code, 'INVALID_PACKAGE_ARCHIVE');
      assert.equal(outcome.message, 'official package archive is invalid');
      if (phase === 'preflight') assert.ok(outcome.tarCode !== undefined, 'fixture must fail during gzip preflight');
      else
        assert.ok(['EEXIST', 'ENOTDIR'].includes(outcome.admissionCode), 'fixture must fail before entering staging');
      const diagnostics = rows.filter((row) => row.module === 'plugin/package-staging');
      assert.equal(diagnostics.length, 1, 'tar cause must be observable instead of disappearing behind HTTP 422');
      assert.equal(diagnostics[0].phase, phase === 'preflight' ? 'preflight' : phase);
      assert.equal(diagnostics[0].platform, process.platform);
      const leaf = phase === 'preflight' ? diagnostics[0].error.cause : diagnostics[0].error;
      assert.equal(leaf.code, phase === 'preflight' ? outcome.tarCode : outcome.admissionCode);
      if (phase === 'preflight') assert.equal(leaf.stderr, outcome.stderr?.slice(0, 2048));
      assert.equal('stack' in diagnostics[0].error, false);
      assert.equal('stdout' in diagnostics[0].error, false);
      assert.equal(stdout.includes('must-not-leak'), false);
      assert.equal(stdout.includes('archive contents must not be logged'), false);
    } finally {
      await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

const realExecFile = childProcess.execFile;
const realExecFileAsync = promisify(realExecFile);
const realRm = fs.rm;
const controlledTar = String.raw`
process.stdout.write('ready\n');
process.stdin.once('data', () => {
  process.stderr.write(process.argv[2] + '\n');
  process.exit(Number(process.argv[1]));
});
`;

for (const failingMode of ['-tzf', '-tvzf']) {
  test(
    `staging waits for both real listing children when ${failingMode} rejects first`,
    { timeout: 15_000 },
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'package-staging-lifetime-'));
      const artifactRoot = join(root, 'artifact');
      const packagesRoot = join(root, 'packages');
      await fs.mkdir(artifactRoot);
      // Pass the current streaming preflight before controlling the two tar listings.
      const sourceRoot = join(root, 'source');
      await fs.mkdir(join(sourceRoot, 'package'), { recursive: true });
      await fs.writeFile(join(sourceRoot, 'package', 'fixture.txt'), 'listing lifetime fixture');
      // Relative operands also work with Windows Git GNU tar, which treats C: as a remote host.
      await realExecFileAsync('tar', ['-czf', 'artifact/package.tgz', '-C', 'source', 'package'], { cwd: root });
      const bytes = await fs.readFile(join(artifactRoot, 'package.tgz'));
      const packageDigest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      const children = [];
      const cleanups = [];
      let bothStarted;
      const started = new Promise((resolve) => {
        bothStarted = resolve;
      });
      // Route only the executable: actual execFile promises, pipes, close events,
      // the private cwd, and the production environment/options remain real.
      const route = (file, args, options) => {
        assert.equal(file, 'controlled-package-tar');
        assert.deepEqual(args.slice(1), ['package.tgz']);
        const execution = realExecFileAsync(
          process.execPath,
          ['-e', controlledTar, args[0] === failingMode ? '7' : '9', args[0]],
          options,
        );
        const record = { mode: args[0], child: execution.child, execution, closed: false };
        execution.catch(() => undefined);
        record.ready = new Promise((resolve, reject) => {
          record.child.stdout.once('data', resolve);
          record.child.once('error', reject);
        });
        record.child.once('close', () => {
          record.closed = true;
        });
        children.push(record);
        if (children.length === 2) bothStarted();
        return execution;
      };
      childProcess.execFile = Object.assign((...args) => realExecFile(...args), { [promisify.custom]: route });
      fs.rm = async (path, options) => {
        if (basename(path).startsWith('.runtime-stage-')) {
          cleanups.push({ path, liveChildren: children.filter((child) => !child.closed).map((child) => child.mode) });
        }
        return realRm(path, options);
      };
      syncBuiltinESMExports();
      let rejection;
      try {
        const { stageVerifiedPackageArchive } = await import(
          `../dist/domains/plugin/external-runtime/package-staging.js?lifetime=${failingMode}`
        );
        rejection = stageVerifiedPackageArchive({
          artifactRoot,
          packagesRoot,
          packageDigest,
          tarBin: 'controlled-package-tar',
        }).then(
          () => assert.fail('invalid archive was admitted'),
          (error) => error,
        );
        await Promise.race([
          started,
          rejection.then((error) => {
            throw error;
          }),
        ]);
        await Promise.all(children.map((child) => child.ready));
        const first = children.find((child) => child.mode === failingMode);
        const sibling = children.find((child) => child !== first);
        first.child.stdin.end('finish');
        await assert.rejects(first.execution, (error) => error.code === 7);
        // Drain the rejection continuations while the sibling remains held by
        // stdin, rather than guessing a duration in which it might still run.
        await setImmediate();
        assert.equal(sibling.closed, false, 'the sibling must still hold the production stage cwd');
        sibling.child.stdin.end('finish');
        await Promise.allSettled(children.map((child) => child.execution));
        const error = await rejection;
        assert.equal(error.code, 'PACKAGE_AUTHORITY_MISMATCH');
        assert.equal(error.cause.code, 7, 'keep the first failure rather than the later sibling error');
        assert.equal(error.cause.stderr.trim(), failingMode);
        assert.equal(cleanups.length, 1, 'failure must release its private stage exactly once');
        assert.deepEqual(cleanups[0].liveChildren, [], 'cleanup must not remove a live tar child cwd');
        assert.deepEqual(await fs.readdir(packagesRoot), [], 'no staging directory may survive rejection');
        assert.deepEqual(await fs.readFile(join(artifactRoot, 'package.tgz')), bytes);
      } finally {
        childProcess.execFile = realExecFile;
        fs.rm = realRm;
        syncBuiltinESMExports();
        for (const record of children) if (!record.closed) record.child.kill();
        await Promise.allSettled(children.map((child) => child.execution));
        if (rejection) await rejection;
        await realRm(root, { recursive: true, force: true });
      }
    },
  );
}
