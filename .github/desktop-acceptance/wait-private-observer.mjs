import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const PRIVATE_OBSERVER_SHA256 = '0e64dc1bb9aaa4bfc58b69d47eaf6dc684b0f86591493c3d04baf488e0801481';
const kinds = ['collective_windows_private_execfile', 'collective_windows_private_readonly_baseline'];

export function privateObserverRecords(text) {
  if (!text.endsWith('\n')) return undefined;
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(rows.length <= 2);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.kind, kinds[index]);
    assert.equal(row.observerSha256, PRIVATE_OBSERVER_SHA256);
  }
  return rows.length === 2 ? rows : undefined;
}

export async function waitForPrivateObserver({ read, now = Date.now, pause = delay, timeoutMs = 70000 }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const rows = privateObserverRecords(read());
    if (rows) return rows;
    await pause(250);
  }
  throw new Error('Private-path observer callback or read-only baseline was not recorded before cleanup');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const directory = path.resolve(process.argv[2]);
  const source = path.join(directory, 'private-observer.jsonl');
  const output = path.join(directory, 'observer-completeness.json');
  let result;
  try {
    const rows = await waitForPrivateObserver({
      read: () => (fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : ''),
    });
    result = {
      complete: true,
      diagnosticOnly: true,
      observerSha256: PRIVATE_OBSERVER_SHA256,
      records: rows.map((row) => row.kind),
      baselineOutcome: rows[1].outcome,
    };
  } catch (error) {
    result = { complete: false, diagnosticOnly: true, reason: error.message };
    process.exitCode = 1;
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(result));
}
