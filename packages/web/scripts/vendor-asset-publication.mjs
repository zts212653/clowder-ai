import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

function publishAsset(dest, writeStaged) {
  mkdirSync(dirname(dest), { recursive: true });
  const stagingDir = mkdtempSync(resolve(dirname(dest), '.vendor-sync-'));
  try {
    const staged = resolve(stagingDir, 'asset');
    writeStaged(staged);
    renameSync(staged, dest);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function copyAsset(src, dest, transform) {
  publishAsset(dest, (staged) => {
    copyFileSync(src, staged);
    if (transform) writeFileSync(staged, transform(readFileSync(staged, 'utf8')));
  });
  console.log(`[sync-vendor-assets] ${src} -> ${dest}`);
}

/** Keep unchanged generated modules quiet so a CSS watcher cannot trigger an HMR loop. */
export function writeTextAsset(dest, contents) {
  if (existsSync(dest) && readFileSync(dest, 'utf8') === contents) return;
  publishAsset(dest, (staged) => writeFileSync(staged, contents));
}
