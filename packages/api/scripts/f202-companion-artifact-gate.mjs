/** Mandatory companion lane. The connector lane consumes the same certified release separately.
 * Usage: node scripts/f202-companion-artifact-gate.mjs --archive /absolute/companion.tgz
 * Requires a clean committed worktree; refuses to label an uncommitted tree as a tested commit.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { COMPANION_ARTIFACT as pin } from '../test/helpers/f202-companion-artifact-pins.js';
import { gitOutput, rebuildHostRuntime } from './m0d-acceptance-provenance.mjs';

const apiRoot = resolve(import.meta.dirname, '..');
const root = resolve(apiRoot, '../..');
const run = promisify(execFile);
const position = process.argv.indexOf('--archive');
const archive = position >= 0 ? process.argv[position + 1] : undefined;
if (!archive || archive.startsWith('--')) throw new Error('pass --archive <companion.tgz>');
if (process.platform !== pin.platform || process.arch !== pin.arch)
  throw new Error('the pinned companion is certified only on darwin-arm64');
const sha256 = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
if (sha256 !== pin.sha256) throw new Error('companion archive digest does not match the pin');
const executedSha = await gitOutput(['rev-parse', 'HEAD'], root);
if (await gitOutput(['status', '--porcelain'], root))
  throw new Error('companion artifact gate requires a clean committed worktree');
const runtime = await rebuildHostRuntime(root);
if (
  (await gitOutput(['status', '--porcelain'], root)) ||
  (await gitOutput(['rev-parse', 'HEAD'], root)) !== executedSha
)
  throw new Error('Host runtime rebuild changed the executed commit or worktree');
let output;
let exitCode = 0;
try {
  output = await run(
    'bash',
    [
      './scripts/with-test-home.sh',
      process.execPath,
      '--import',
      './test/helpers/setup-cat-registry.js',
      '--test',
      '--test-reporter=tap',
      'test/f202-h3c3-companion-artifact.test.js',
      'test/f202-h3c3-production-composition.test.js',
    ],
    {
      cwd: apiRoot,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, F202_COMPANION_ARCHIVE: resolve(archive), F202_ARTIFACT_GATE_REQUIRED: '1' },
    },
  );
} catch (error) {
  output = { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  exitCode = 1;
}
const counts = Object.fromEntries(
  ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((name) => {
    const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output.stdout);
    return [name, match ? Number(match[1]) : null];
  }),
);
const unchanged =
  (await gitOutput(['rev-parse', 'HEAD'], root)) === executedSha &&
  (await gitOutput(['status', '--porcelain'], root)) === '';
const passed =
  unchanged &&
  exitCode === 0 &&
  counts.tests === pin.expectedCases &&
  counts.pass === pin.expectedCases &&
  ['fail', 'cancelled', 'skipped', 'todo'].every((name) => counts[name] === 0);
process.stdout.write(
  `${JSON.stringify(
    {
      gate: 'f202-companion-artifact',
      executedSha,
      runtime,
      pin,
      sha256,
      counts,
      unchanged,
      passed,
      nonClaims: ['Synthetic helper, not real Chrome or account acceptance.', 'Not human acceptance or fork soak.'],
      ...(passed ? {} : { output }),
    },
    null,
    2,
  )}\n`,
);
if (!passed) process.exitCode = 1;
