import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startReviewHost } from './f309-artifact-review-host.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { values } = parseArgs({
  options: { port: { type: 'string', default: '4319' }, 'data-dir': { type: 'string' } },
  allowPositionals: false,
});
const port = Number(values.port);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'A local preview port is required.');
assert.ok(![3001, 3002, 3011, 3012, 4111, 6398, 6399].includes(port), 'Reserved environment port.');
assert.equal(process.env.NODE_ENV, 'test', 'Start the isolated preview with NODE_ENV=test.');
assert.notEqual(
  process.env.CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD,
  '1',
  'A long-lived preview cannot retain a test permit; apply the resource wrapper only to the finite browser journey.',
);
const clientRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const parent = path.resolve(values['data-dir'] ?? path.join(repository, 'var/f309-artwork-preview'));
await mkdir(parent, { recursive: true });
// Keep every session: no TTL or restart cleanup of user-entered preview work.
const root = await mkdtemp(path.join(parent, 'session-'));
const source = path.join(repository, 'packages/web/public/visible-cafe/scenes/main-planet-bg.png');
const input = path.join(root, 'review-input.png');
// Use the complete first-party artwork; screenshot controls must not appear inside the media.
await copyFile(source, input);
const sourceHash = createHash('sha256')
  .update(await readFile(source))
  .digest('hex');
const inputHash = createHash('sha256')
  .update(await readFile(input))
  .digest('hex');
const host = await startReviewHost(root, 'image/png', { port, clientRevision });
const receipt = {
  kind: 'isolated-real-shell-experience',
  clientRevision,
  origin: host.origin,
  apiOrigin: host.apiOrigin,
  root,
  threadId: host.thread.id,
  taskId: host.taskId,
  source: path.relative(repository, source),
  sourceSha256: sourceHash,
  inputSha256: inputHash,
  mediaTransform: 'Byte-for-byte copy of the first-party Visible Cafe room illustration; no transformation.',
  persistence:
    'Point/region comments, explicitly saved visual marks and image editing requests use the real isolated review owner/SQLite. Unsubmitted marks remain recoverable browser drafts. Image edits return to the original task and require a new media version. No production data.',
  restart:
    'Each launch creates a new isolated thread. Previous SQLite and browser drafts are retained, not automatically rebound.',
};
await writeFile(path.join(root, 'preview.json'), `${JSON.stringify(receipt, null, 2)}\n`);
await writeFile(path.join(parent, 'current.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await host.close();
    process.exit(0);
  });
}
