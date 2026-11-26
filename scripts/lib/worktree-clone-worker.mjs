/** Bounded cp workers; the synchronous creator waits for this process before Git verification. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function copy(args) {
  return new Promise((resolve) => {
    const child = spawn('/bin/cp', args, { stdio: 'ignore' });
    // Partial/failed copies are inspected by the creator and repaired from the target index.
    child.once('error', resolve);
    child.once('close', resolve);
  });
}

export async function runCloneJobs(jobs, execute = copy) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) await execute(jobs[next++]);
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCloneJobs(JSON.parse(readFileSync(0, 'utf8')));
}
