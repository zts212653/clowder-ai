import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('failed archive listing waits for every started child before cleanup and rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'staging-processes-'));
  const artifactRoot = join(root, 'artifact');
  const packagesRoot = join(root, 'packages');
  await mkdir(artifactRoot);
  const bytes = Buffer.from('digest-valid test bytes');
  await writeFile(join(artifactRoot, 'package.tgz'), bytes);
  const program = join(root, 'controlled-list.cjs');
  const started = join(root, 'second-started');
  const release = join(root, 'release-second');
  const terminal = join(root, 'second-terminal');
  await writeFile(
    program,
    `
const fs = require('node:fs');
const [mode, started, release, terminal] = process.argv.slice(2);
const deadline = Date.now() + 10000;
const timer = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(timer); process.exit(98); }
  if (mode === '-tzf' && fs.existsSync(started)) { clearInterval(timer); process.stderr.write('fixture-list-failure'); process.exit(2); }
  if (mode === '-tvzf' && fs.existsSync(release)) { clearInterval(timer); fs.writeFileSync(terminal, 'done'); process.exit(3); }
}, 5);
if (mode === '-tvzf') fs.writeFileSync(started, 'ready');
`,
  );
  const execFile = childProcess.execFile;
  const children = [];
  const closed = [];
  let stageParent;
  // A fresh wrapper deliberately has no execFile custom-promisify property that
  // could bypass the controlled child. Restore the builtin in this isolated test process.
  childProcess.execFile = (command, args, options, callback) => {
    assert.equal(command, 'controlled-tar');
    stageParent = options.cwd;
    const child = execFile(
      process.execPath,
      [program, args[0], started, release, terminal],
      options,
      (error, stdout, stderr) => {
        if (error) Object.assign(error, { stdout, stderr });
        callback(error, { stdout, stderr });
      },
    );
    children.push(child);
    closed.push(new Promise((resolve) => child.once('close', resolve)));
    return child;
  };
  syncBuiltinESMExports();
  try {
    const { stageVerifiedPackageArchive } = await import('../dist/domains/plugin/external-runtime/package-staging.js');
    const operation = stageVerifiedPackageArchive({
      artifactRoot,
      packagesRoot,
      tarBin: 'controlled-tar',
      packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }).then(
      () => {
        throw new Error('invalid listing admitted');
      },
      (error) => error,
    );
    // The second child is released only after the API settles or the first child's close
    // has been processed. The first error must never be observable before the second exit.
    const deadline = Date.now() + 10_000;
    while (children.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(children.length, 2, 'fixture must start both controlled list processes');
    await closed[0];
    const observed = await Promise.race([
      operation.then((error) => ({ returned: true, error })),
      new Promise((resolve) => setTimeout(() => resolve({ returned: false }), 100)),
    ]);
    const stillStaged = existsSync(stageParent);
    await writeFile(release, 'go');
    const error = observed.returned ? observed.error : await operation;
    await Promise.all(closed);
    assert.equal(observed.returned, false, 'API rejected while the verbose-list child was still blocked');
    assert.equal(stillStaged, true, 'staging was removed while a child still owned its cwd');
    assert.equal(await readFile(terminal, 'utf8'), 'done');
    assert.equal(error.code, 'PACKAGE_AUTHORITY_MISMATCH');
    assert.equal(error.cause.code, 2, 'retain the first list failure instead of the later verbose-list error');
    assert.equal(error.cause.stderr, 'fixture-list-failure');
    assert.equal(existsSync(stageParent), false);
  } finally {
    await writeFile(release, 'go');
    for (const child of children) if (child.exitCode === null) child.kill();
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
  }
});
