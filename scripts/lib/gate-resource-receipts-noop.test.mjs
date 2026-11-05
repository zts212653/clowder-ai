import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeGateResourceReceipt } from './gate-resource-receipts.mjs';

test('repeated identical receipt publication preserves its inode and modification time', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-noop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'request.json');
  const receipt = { requestId: 'same-request', status: 'queued', waitDurationMs: 0 };
  writeGateResourceReceipt(file, receipt);
  utimesSync(file, 1, 1);
  const before = statSync(file, { bigint: true });
  for (let index = 0; index < 100; index += 1) writeGateResourceReceipt(file, receipt);
  const after = statSync(file, { bigint: true });
  assert.equal(after.ino, before.ino, 'no new inode for unchanged evidence');
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(readdirSync(root), ['request.json']);
  writeGateResourceReceipt(file, { ...receipt, status: 'acquired' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'acquired');
  assert.notEqual(statSync(file, { bigint: true }).ino, before.ino, 'changed evidence remains atomic');
  writeFileSync(file, '{broken');
  writeGateResourceReceipt(file, receipt);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), receipt);
});

test('equal bytes behind symlinks or writable files do not qualify as stable owned receipts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gate-receipt-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = { requestId: 'request', status: 'released' };
  const original = join(root, 'original.json');
  const file = join(root, 'request.json');
  writeGateResourceReceipt(original, receipt);
  const before = statSync(original, { bigint: true });
  symlinkSync(original, file);
  writeGateResourceReceipt(file, receipt);
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(statSync(original, { bigint: true }).ino, before.ino);
  chmodSync(file, 0o666);
  const writableInode = statSync(file, { bigint: true }).ino;
  writeGateResourceReceipt(file, receipt);
  assert.notEqual(statSync(file, { bigint: true }).ino, writableInode);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
