import { channel } from 'node:diagnostics_channel';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const optionsUrl = new URL(import.meta.url).searchParams.get('options');
const options = JSON.parse(fs.readFileSync(fileURLToPath(optionsUrl), 'utf8'));
const seen = new Set();
let checkpoints = 0;
let checkpointMs = 0;
channel('cat-cafe.entity-mention-checkpoint').subscribe((result) => {
  checkpoints++;
  checkpointMs += result.durationMs;
  if (checkpoints === 1 || checkpoints % 100 === 0)
    console.log('[startup-profile-checkpoints]', JSON.stringify({ checkpoints, checkpointMs, ...result }));
});
const hook = registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (url.startsWith('file:')) seen.add(url);
    return result;
  },
});
const original = globalThis.__clowderStartupMilestone;
globalThis.__clowderStartupMilestone = (phase) => {
  original(phase);
  if (phase !== 'http-listening') return;
  hook.deregister();
  fs.writeFileSync(path.join(options.profileRoot, 'files.json'), JSON.stringify([...seen]));
};
