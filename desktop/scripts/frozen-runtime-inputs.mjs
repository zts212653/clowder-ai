import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/** Tracked source only; prepared release snapshots carry the same inventory. */
export async function readFrozenRuntimeInputs(source) {
  const inventoryFile = path.join(source, '.build-input-files.json');
  let tracked;
  if (fs.existsSync(inventoryFile)) tracked = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  else {
    const child = spawn('git', ['ls-files', '-z', '--', 'packages', 'scripts', 'patches'], {
      cwd: source,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [stdout, stderr, [code]] = await Promise.all([
      child.stdout.toArray(),
      child.stderr.toArray(),
      once(child, 'close'),
    ]);
    if (code !== 0) throw new Error(`Git inventory failed (exit ${code}): ${Buffer.concat(stderr).toString('utf8')}`);
    tracked = Buffer.concat(stdout).toString('utf8').split('\0').filter(Boolean);
  }
  return tracked.filter((relative) => /^(packages|scripts|patches)\//.test(relative));
}
