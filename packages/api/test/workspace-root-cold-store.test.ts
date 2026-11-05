import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  linkedRootConfigPath,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import {
  issueRootConnectionProof,
  verifyRootConnectionProof,
} from '../src/domains/workspace/roots/workspace-root-proof.js';
import { rootStoreFixture } from './helpers/workspace-root-store-fixture.js';

const loader = import.meta.resolve('tsx');
const verifier = fileURLToPath(new URL('./helpers/workspace-root-proof-child.ts', import.meta.url));
const issuer = fileURLToPath(new URL('./helpers/workspace-root-proof-issuer.ts', import.meta.url));
const digest = () =>
  createHash('sha256')
    .update(readFileSync(join(dirname(linkedRootConfigPath()), 'secrets', 'root-preparation.key')))
    .digest('hex');

function verifyElsewhere(token: string, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--import', loader, verifier],
      { cwd, env: process.env, timeout: 20000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      },
    );
    assert.ok(child.stdin);
    child.stdin.end(token);
  });
}

test('three native cold stores preserve their signing identity on retry and in a new process', async (t) => {
  const root = await rootStoreFixture(t);
  for (let index = 0; index < 3; index++) {
    process.env.CAT_CAFE_DATA_DIR = join(root, `cold-${index}`);
    const claims = { userId: 'operator', root, expectedEpoch: 0, source: { kind: 'directory-selection' as const } };
    const first = issueRootConnectionProof(claims);
    const firstDigest = digest();
    assert.deepEqual(verifyRootConnectionProof(first), claims);
    assert.deepEqual(verifyRootConnectionProof(issueRootConnectionProof(claims)), claims);
    assert.equal(digest(), firstDigest);
    const cwd = join(root, `restart-${index}`);
    await mkdir(cwd);
    assert.deepEqual(await verifyElsewhere(first, cwd), claims);
    assert.equal(digest(), firstDigest);
    assert.equal(readLinkedRootState().roots.length, 0, 'issuing a proof grants no root');
  }
});

test('concurrent first issuers publish one key and both proofs verify after restart', async (t) => {
  const root = await rootStoreFixture(t);
  const jobs = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--import', loader, issuer, root], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (data) => {
        stdout += String(data);
        if (stdout.startsWith('ready\n')) resolve();
      });
      child.once('exit', () => {
        if (!stdout.startsWith('ready\n')) reject(new Error(stderr));
      });
    });
    const result = new Promise<{ proof: string; keyDigest: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(stderr));
        else resolve(JSON.parse(stdout.slice('ready\n'.length)));
      });
    });
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('exit', () => clearTimeout(timer));
    t.after(() => {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    });
    return { child, ready, result };
  });
  await Promise.all(jobs.map((job) => job.ready));
  for (const job of jobs) job.child.stdin.end('go\n');
  const results = await Promise.all(jobs.map((job) => job.result));
  const cwd = join(root, 'restart');
  await mkdir(cwd);
  for (const result of results) {
    assert.equal(result.keyDigest, digest());
    assert.deepEqual(await verifyElsewhere(result.proof, cwd), {
      userId: 'operator',
      root,
      expectedEpoch: 0,
      source: { kind: 'directory-selection' },
    });
  }
});
