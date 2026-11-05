/** Mandatory paired owner/carrier gate. Ordinary Host CI cannot substitute for this archive run. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gitOutput, rebuildHostRuntime } from './m0d-acceptance-provenance.mjs';

const apiRoot = resolve(import.meta.dirname, '..');
const root = resolve(apiRoot, '../..');
const matrixPath = process.env.F202_CANDIDATE_MATRIX;
if (!matrixPath) throw new Error('Set F202_CANDIDATE_MATRIX to the exact paired package matrix');
const matrixBytes = await readFile(matrixPath);
const matrix = JSON.parse(matrixBytes);
const collective = matrix.allPackages.find((row) => row.name === '@clowder-ai/collective-connector');
if (!collective) throw new Error('Collective package missing from matrix');
const archiveSha256 = createHash('sha256')
  .update(await readFile(collective.path ?? collective.archive))
  .digest('hex');
if (archiveSha256 !== collective.sha256) throw new Error('Collective archive digest does not match');
const head = await gitOutput(['rev-parse', 'HEAD'], root);
if (await gitOutput(['status', '--porcelain'], root))
  throw new Error('Commit the reviewed Host candidate before the paired gate');
const runtime = await rebuildHostRuntime(root);
if ((await gitOutput(['rev-parse', 'HEAD'], root)) !== head || (await gitOutput(['status', '--porcelain'], root)))
  throw new Error('Host changed during rebuild');
const files = (await readdir(resolve(apiRoot, 'test'))).filter((name) => /^collective-.*\.test\.ts$/.test(name)).sort();
files.push(
  'f202-collective-owner-proxy.test.ts',
  'f202-collective-retained-media.test.ts',
  'f202-collective-artifact-task.test.js',
  'plugin-webhook-stream.test.ts',
);
const execution = await new Promise((resolveRun, reject) => {
  const child = spawn(
    'bash',
    [
      './scripts/with-test-home.sh',
      process.execPath,
      '--import',
      'tsx',
      '--import',
      './test/helpers/setup-cat-registry.js',
      '--test',
      '--test-reporter=tap',
      '--test-concurrency=2',
      '--test-timeout=120000',
      ...files.map((name) => `test/${name}`),
    ],
    {
      cwd: apiRoot,
      env: { ...process.env, CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1', F202_ARTIFACT_GATE_REQUIRED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', reject);
  child.once('close', (code) => resolveRun({ code, stdout, stderr }));
});
const count = (name) => {
  const found = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(execution.stdout);
  return found ? Number(found[1]) : null;
};
const counts = Object.fromEntries(
  ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].map((name) => [name, count(name)]),
);
const passed =
  execution.code === 0 &&
  counts.tests > 0 &&
  counts.pass === counts.tests &&
  ['fail', 'skipped', 'cancelled', 'todo'].every((name) => counts[name] === 0);
process.stdout.write(
  JSON.stringify(
    {
      gate: 'collective-installed-owner',
      head,
      runtime,
      matrixSha256: createHash('sha256').update(matrixBytes).digest('hex'),
      package: { name: collective.name, version: collective.version, sha256: archiveSha256 },
      files,
      counts,
      passed,
      ...(passed ? {} : { output: `${execution.stdout}\n${execution.stderr}` }),
    },
    null,
    2,
  ) + '\n',
);
if (!passed) process.exitCode = 1;
