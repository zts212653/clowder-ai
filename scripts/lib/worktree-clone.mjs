/** APFS detection and batch clone transport. Content verification belongs to Git. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function supportsApfsClone(source, destination) {
  if (process.platform !== 'darwin') return false;
  try {
    if (statSync(source).dev !== statSync(destination).dev) return false;
    // cp -c silently copies on unsupported filesystems. Restrict it to one APFS volume.
    const device = execFileSync('/bin/df', ['-P', destination], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .at(-1)
      .trim()
      .split(/\s+/)[0];
    const info = execFileSync('/usr/sbin/diskutil', ['info', '-plist', device], { encoding: 'utf8' });
    return /<key>FilesystemType<\/key>\s*<string>apfs<\/string>/.test(info);
  } catch {
    return false;
  }
}

export function cloneBatch(files) {
  // Native Node COPYFILE_FICLONE_FORCE returns ENOSYS on macOS. cp uses clonefile(2).
  execFileSync('/bin/cp', ['-c', ...files.map((file) => file.source), dirname(files[0].destination)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function copyCloneCandidates(files, copy = cloneBatch) {
  const groups = new Map();
  const jobs = [];
  for (const file of files) {
    const dir = dirname(file.destination);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  for (const [dir, group] of groups) {
    mkdirSync(dir, { recursive: true });
    let batch = [],
      bytes = 0;
    const flush = () => {
      if (!batch.length) return;
      if (copy === cloneBatch) jobs.push(['-c', ...batch.map((file) => file.source), dir]);
      else {
        try {
          copy(batch);
        } catch {
          /* Inspect every destination; Git fills any failed copies. */
        }
      }
      batch = [];
      bytes = 0;
    };
    for (const file of group) {
      // Bound argv below macOS ARG_MAX, including repositories with long absolute paths.
      const size = Buffer.byteLength(file.source) + 1;
      if (bytes + size > 64 * 1024) flush();
      batch.push(file);
      bytes += size;
    }
    flush();
  }
  if (jobs.length)
    execFileSync(process.execPath, [fileURLToPath(new URL('./worktree-clone-worker.mjs', import.meta.url))], {
      input: JSON.stringify(jobs),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}
