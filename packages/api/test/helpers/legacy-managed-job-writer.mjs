import { appendFileSync } from 'node:fs';
import {
  initializeDurableManagedGateJob,
  readDurableGateRecord,
  settleDurableManagedGateJobFromRunner,
  writeDurableGateRecord,
} from '../../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { readUnixProcessSnapshotSync } from '../../dist/utils/cli-process-ownership.js';

// A controlled legacy producer uses the real file-ledger protocol and remains alive across recovery workers.
const job = JSON.parse(process.argv[2]);
const marker = process.argv[3];
initializeDurableManagedGateJob(job);
const ownerIdentity = readUnixProcessSnapshotSync({ pids: [process.pid] }).get(process.pid);
writeDurableGateRecord(job, {
  ...readDurableGateRecord(job),
  descriptor: job,
  state: 'running',
  ownerIdentity,
  updatedAt: Date.now(),
});
appendFileSync(marker, 'start\n');
process.send({ kind: 'ready' });
process.on('message', (message) => {
  if (message !== 'complete') return;
  const result = { exitCode: 3, timedOut: false, durationMs: 25, tailOutput: 'legacy original result' };
  if (!settleDurableManagedGateJobFromRunner(job, result)) throw new Error('legacy producer failed to settle');
  process.send({ kind: 'terminal', result });
});
