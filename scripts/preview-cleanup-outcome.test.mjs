import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { previewCleanupExitCode, readCleanupOwnerResult } from './lib/preview-cleanup-result.mjs';

const source = readFileSync(new URL('./start-dev.sh', import.meta.url), 'utf8');
const extract = (name) => {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body);
  return body;
};
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'preview-outcome-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

for (const cleanup of [0, 1]) {
  test(`real EXIT trap keeps business failure separate from cleanup ${cleanup}`, (t) => {
    const root = fixture(t);
    const resultPath = join(root, 'owner.json');
    const result = spawnSync('bash', ['-eu'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: root, RESULT_PATH: resultPath },
      input: `CLI_PREVIEW_CLEANUP_RESULT="$RESULT_PATH"
PREVIEW_CLEANUP_PROCESS_GROUP=12345
cleanup() { return ${cleanup}; }
${extract('publish_preview_cleanup_result')}
${extract('finish_launcher')}
${source.match(/^trap 'finish_launcher.* EXIT$/m)?.[0]}
exit 1
`,
    });
    assert.equal(result.status, 1, result.stderr);
    const owner = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(owner.version, 2);
    assert.equal(owner.commandExitCode, 1);
    assert.equal(owner.cleanupExitCode, cleanup);
  });
}

for (const wrapped of [false, true])
  test(`real runner preserves business exit1 and cleanup0 ${wrapped ? 'through an early-zero wrapper' : 'directly'}`, (t) => {
    const root = fixture(t);
    const script = join(root, 'owner.sh');
    writeFileSync(
      script,
      `#!/bin/bash
group=$(ps -p "$$" -o pgid= | tr -d ' ')
printf '{"version":2,"pid":%s,"processGroupId":%s,"exitCode":0,"commandExitCode":1,"cleanupExitCode":0}' "$$" "$group" > "$CAT_CAFE_PREVIEW_CLEANUP_RESULT"
exit 1
`,
    );
    const completionPath = join(root, 'completion.json');
    const wrapper = join(root, 'wrapper.cjs');
    writeFileSync(
      wrapper,
      "const {spawn}=require('node:child_process'); const child=spawn('/bin/bash',[process.argv[2]],{stdio:'inherit'}); child.on('exit',()=>{process.exitCode=0;});\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./preview-process-lease-runner.mjs', import.meta.url)),
        '--expires-at',
        new Date(Date.now() + 60000).toISOString(),
        '--completion-path',
        completionPath,
        '--',
        ...(wrapped ? [process.execPath, wrapper, script] : ['/bin/bash', script]),
      ],
      { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 1, result.stderr);
    const completion = JSON.parse(readFileSync(completionPath, 'utf8'));
    assert.equal(completion.exitCode, 1);
    assert.equal(completion.version, 2);
    assert.equal(completion.commandExitCode, 1);
    assert.equal(completion.cleanupExitCode, 0);
    assert.equal(completion.runnerExitCode, wrapped ? 0 : 1);
  });

test('legacy owner exit0 has no explicit versioned cleanup proof', (t) => {
  const path = join(fixture(t), 'legacy.json');
  writeFileSync(path, JSON.stringify({ pid: 123, processGroupId: 456, exitCode: 0 }));
  assert.equal(readCleanupOwnerResult(path, 456).cleanupExitCode ?? null, null);
  assert.equal(
    previewCleanupExitCode({
      outcome: { code: 1 },
      graceful: true,
      owner: { status: 'complete', exitCode: 0 },
      descendantsRemain: false,
      shutdownRequested: false,
      requireOwnerResult: true,
    }),
    1,
  );
});
