import { readFileSync, unlinkSync } from 'node:fs';
import { failedAlphaFixture } from './preview-alpha-recovery-test-fixture.mjs';
import { stopManagedPreview } from './preview-process-stop.mjs';

export function stoppedFixture(t) {
  const f = failedAlphaFixture(t);
  unlinkSync(f.leaseFile);
  f.recovery.isRunning = () => false;
  f.recovery.readListeners = () => [];
  f.recovery.run = () => {
    throw new Error('settlement must not send a Redis command');
  };
  return f;
}

export const stop = (f) =>
  stopManagedPreview(f.config, { record: f.record, status: 'stopped' }, { recovery: f.recovery });

export const original = (f) => ({
  completion: readFileSync(f.record.completionPath),
  owner: readFileSync(`${f.record.completionPath}.owner.json`),
  rdb: readFileSync(f.dumpFile),
});
