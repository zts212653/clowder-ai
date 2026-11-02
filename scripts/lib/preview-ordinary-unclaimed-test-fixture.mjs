import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { stoppedFixture } from './preview-alpha-settlement-test-fixture.mjs';
import { previewProcessRecordId } from './preview-process-record-key.mjs';

export function ordinaryUnclaimedFixture(t, version = 'legacy') {
  const f = stoppedFixture(t),
    oldPath = f.config.recordPath,
    oldCompletion = f.record.completionPath;
  unlinkSync(`${oldCompletion}.owner.json`);
  const cwd = join(f.directory, 'cat-cafe-source-feature');
  mkdirSync(cwd);
  const port = Number(
    execFileSync(
      process.execPath,
      [
        '-e',
        "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()});",
      ],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: f.directory } },
    ).trim(),
  );
  const id = previewProcessRecordId(cwd, port),
    completionPath = join(f.config.stateDir, `${id}.11111111-1111-4111-8111-111111111111.completion.json`);
  f.config = { ...f.config, cwd, port, id, recordPath: join(f.config.stateDir, `${id}.json`) };
  f.record = {
    ...f.record,
    id,
    cwd,
    port,
    completionPath,
    readyAt: '2026-09-30T20:00:00.000Z',
    command: [process.execPath, join(cwd, 'source.mjs')],
  };
  unlinkSync(oldPath);
  renameSync(oldCompletion, completionPath);
  f.completion = { ...f.completion, exitCode: 1, cleanupOwnerStatus: 'unclaimed' };
  if (version === 'v2')
    f.completion = { ...f.completion, version: 2, commandExitCode: null, runnerExitCode: null, cleanupExitCode: null };
  f.write(f.config.recordPath, f.record);
  f.write(completionPath, f.completion);
  f.recovery.readHost = () => ({ confidence: 'none' });
  return f;
}
