import { unlinkSync } from 'node:fs';
import { stoppedFixture } from './preview-alpha-settlement-test-fixture.mjs';

export function unclaimed(t) {
  const f = stoppedFixture(t);
  unlinkSync(`${f.record.completionPath}.owner.json`);
  f.completion = {
    ...f.completion,
    version: 2,
    exitCode: 2,
    commandExitCode: 2,
    runnerExitCode: 2,
    cleanupExitCode: null,
    cleanupOwnerStatus: 'unclaimed',
  };
  f.write(f.record.completionPath, f.completion);
  f.recovery.readCwds = () => [];
  return f;
}
