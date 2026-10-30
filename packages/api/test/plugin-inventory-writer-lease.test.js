import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { FilePluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';

test('another process cannot enter an active transaction; released writers can retry', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'inventory-writer-')), 'inventory.json');
  await new FilePluginInventoryStore(path).transaction(() => {});
  await new FilePluginInventoryStore(path).transaction(() => {});
  const module = new URL('../dist/domains/plugin/host-inventory/stores.js', import.meta.url).href;
  await new FilePluginInventoryStore(path).transaction(() => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {FilePluginInventoryStore}=await import(${JSON.stringify(module)});try{await new FilePluginInventoryStore(process.argv[1]).transaction(()=>{throw new Error('MUTATION REACHED')});process.exit(2)}catch(e){console.log(e.message);process.exit(e.message.includes('live writer transaction')?0:3)}`,
        path,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stdout, /live writer transaction/);
  });
  await new FilePluginInventoryStore(path).transaction(() => {});
});

for (const kind of ['pending publication', 'reused live PID']) {
  test(`obsolete PID metadata (${kind}) cannot block native lock recovery`, async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inventory-recover-')), 'inventory.json');
    const parent = statSync(dirname(path), { bigint: true });
    const filename = process.platform === 'win32' ? basename(path).toLowerCase() : basename(path);
    const key = createHash('sha256').update(`${parent.dev}:${parent.ino}:${filename}`).digest('hex').slice(0, 24);
    const directory = join(dirname(path), '.plugin-inventory-writers', key);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, kind === 'pending publication' ? 'interrupted.pending' : 'previous.json'),
      kind === 'pending publication'
        ? ''
        : JSON.stringify({ schemaVersion: 2, pid: process.pid, birth: 'previous-process-birth' }),
    );
    await new FilePluginInventoryStore(path).transaction(() => {});
  });
}

test('OS releases a writer lock when its exact child process crashes', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'inventory-crash-')), 'inventory.json');
  const module = new URL('../dist/domains/plugin/host-inventory/stores.js', import.meta.url).href;
  // Keep the suspended transaction reachable while GC runs before the contention check.
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `const{FilePluginInventoryStore}=await import(${JSON.stringify(module)});
      await new FilePluginInventoryStore(process.argv[1]).transaction(async()=>{
        setImmediate(()=>{global.gc();setImmediate(()=>console.log('READY'));});
        await new Promise(resolve=>process.once('message',resolve));
      });`,
      path,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  try {
    const [ready] = await once(child.stdout, 'data');
    assert.match(String(ready), /READY/);
    await assert.rejects(
      new FilePluginInventoryStore(path).transaction(() => {}),
      /live writer transaction/,
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await new FilePluginInventoryStore(path).transaction(() => {});
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('aliases share the queue; recreated projects acquire a fresh transaction lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inventory-alias-'));
  const alias = `${root}-alias`;
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const a = new FilePluginInventoryStore(join(root, 'inventory.json'));
  const b = new FilePluginInventoryStore(join(alias, 'inventory.json'));
  const observed = [];
  await Promise.all([
    a.transaction(async () => {
      observed.push('first');
      await new Promise((r) => setTimeout(r, 10));
      observed.push('finished');
    }),
    b.transaction(() => {
      observed.push('second');
    }),
  ]);
  assert.deepEqual(observed, ['first', 'finished', 'second']);
  // Keep the original lock/database and all files; simulate a replacement, never delete storage.
  renameSync(root, `${root}-retained`);
  mkdirSync(root);
  await new FilePluginInventoryStore(join(root, 'inventory.json')).transaction(() => {});
});

test('corrupt auxiliary locks retain their actual diagnostic and cannot be mistaken for contention', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'inventory-corrupt-lock-')), 'inventory.json');
  writeFileSync(`${path}.writer-lock.sqlite`, 'corrupt lock fixture');
  await assert.rejects(
    new FilePluginInventoryStore(path).transaction(() => {}),
    (e) => e.code === 'SQLITE_NOTADB' && !e.message.includes('live writer'),
  );
});
