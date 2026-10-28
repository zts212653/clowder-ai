import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryPathExists, recoverySnapshot } from './preview-alpha-recovery-evidence.mjs';

/** Opaque byte preservation, including AOF sets; no parsing, repair, replay or SAVE claim. */
export function snapshotRedisRetirementData(evidence) {
  const roots = [evidence.proof.dataDirectory, join(evidence.coordinates.alphaRoot, '.cat-cafe/redis-backups')];
  const directories = [],
    files = [];
  let nodes = 0,
    total = 0;
  function visitDirectory(path, depth) {
    const names = readdirSync(path).sort();
    if (names.length > 256) throw new Error('Redis retirement directory exceeds its bound');
    directories.push({ path, present: true, names });
    for (const name of names) visit(join(path, name), depth + 1);
  }
  function visit(path, depth) {
    if (++nodes > 256 || depth > 4) throw new Error('Redis retirement file set exceeds its bound');
    if (!recoveryPathExists(path)) {
      directories.push({ path, present: false });
      return;
    }
    const st = lstatSync(path);
    if (realpathSync(path) !== path || st.isSymbolicLink()) throw new Error('Redis retirement data is linked');
    if (st.isDirectory()) {
      visitDirectory(path, depth);
    } else {
      if (!st.isFile()) throw new Error('Redis retirement data must be regular files');
      const snapshot = recoverySnapshot(path, { maxBytes: Math.min(256 * 1024 * 1024, 512 * 1024 * 1024 - total) });
      total += snapshot.bytes.length;
      files.push(snapshot);
    }
  }
  for (const root of roots) visit(root, 0);
  return {
    files,
    directories,
    fingerprint: JSON.stringify({ directories, files: files.map((s) => [s.path, s.sha256]) }),
  };
}
