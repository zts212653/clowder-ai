import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  linkedRootConfigPath,
  readLinkedRootState,
} from '../src/domains/workspace/roots/workspace-linked-root-store.js';
import { addLinkedRoot, getLinkedRootsAsync, removeLinkedRoot } from '../src/domains/workspace/workspace-security.js';

const childPath = fileURLToPath(new URL('./helpers/workspace-root-connection-child.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

test('independent API processes preserve concurrent roots and read removed-operation receipts after a cwd change', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-root-processes-'));
  const prior = process.env.CAT_CAFE_DATA_DIR;
  const children: ReturnType<typeof spawn>[] = [];
  try {
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    const jobs = [];
    for (let index = 0; index < 6; index++) {
      const cwd = join(temp, `process-${index}`);
      const root = join(cwd, 'same-name');
      await mkdir(root, { recursive: true });
      const canonical = await realpath(root);
      const child = spawn(
        process.execPath,
        ['--import', loader, childPath, 'connect', `operation-${index}`, canonical],
        { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      children.push(child);
      let output = '';
      let error = '';
      const ready = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (data) => {
          output += String(data);
          if (output.includes('ready\n')) resolve();
        });
        child.once('exit', (code) => {
          if (!output.includes('ready\n')) reject(new Error(`before ready: ${code} ${error}`));
        });
      });
      child.stderr.on('data', (data) => {
        error += String(data);
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(error))));
      });
      jobs.push({ ready, done, child });
    }
    await Promise.all(jobs.map((job) => job.ready));
    for (const job of jobs) job.child.stdin.end('go\n');
    await Promise.all(jobs.map((job) => job.done));
    const state = readLinkedRootState();
    assert.equal(state.roots.length, 6);
    assert.equal(state.operations.length, 6);
    assert.equal(new Set(state.roots.map((root) => root.id)).size, 6, 'labels do not define root identity');
    const first = state.operations.find((operation) => operation.operationId === 'operation-0')!;
    assert.equal(await removeLinkedRoot(first.rootId), true);
    const elsewhere = join(temp, 'restart');
    await mkdir(elsewhere);
    const result = await promisify(execFile)(process.execPath, ['--import', loader, childPath, 'read', 'operation-0'], {
      cwd: elsewhere,
      env: process.env,
    });
    assert.equal(JSON.parse(result.stdout).connected, false);
    assert.equal(JSON.parse(result.stdout).receiptRef, first.receiptRef);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    if (prior === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = prior;
    await rm(temp, { recursive: true, force: true });
  }
});

test('legacy rows migrate without rewriting their source; same-name writes cannot overwrite another root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-root-migration-'));
  const cwd = process.cwd();
  const prior = process.env.CAT_CAFE_DATA_DIR;
  try {
    process.chdir(temp);
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    const a = join(temp, 'A');
    const b = join(temp, 'B');
    await Promise.all([mkdir(a), mkdir(b), mkdir(join(temp, '.cat-cafe'))]);
    const oldPath = join(temp, '.cat-cafe', 'linked-roots.json');
    const legacy = JSON.stringify([{ name: 'original', path: await realpath(a) }]);
    await writeFile(oldPath, legacy);
    await addLinkedRoot('new-root', b);
    assert.equal((await getLinkedRootsAsync()).filter((entry) => entry.removable).length, 2);
    assert.equal(await readFile(oldPath, 'utf8'), legacy);
    const before = await readFile(linkedRootConfigPath(), 'utf8');
    await assert.rejects(addLinkedRoot('original', b), /another root/);
    assert.equal(await readFile(linkedRootConfigPath(), 'utf8'), before);
  } finally {
    process.chdir(cwd);
    if (prior === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = prior;
    await rm(temp, { recursive: true, force: true });
  }
});
