import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('encoded native lease starts the exact literal child argv and retains cleanup evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-lease-argv-'));
  const output = join(root, 'argv.json'),
    program = join(root, 'child.cjs'),
    completion = join(root, 'completion.json');
  const args = ['a\nb', 'a\tb', 'a\rb', 'literal\\012', '中文', '& echo injected', 'space here'];
  writeFileSync(
    program,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.env.CAT_CAFE_PREVIEW_CLEANUP_RESULT,JSON.stringify({pid:process.pid,processGroupId:process.pid,exitCode:0}));`,
  );
  try {
    const encoded = Buffer.from(JSON.stringify([process.execPath, program, ...args])).toString('base64url');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./preview-process-lease-runner.mjs', import.meta.url)),
        '--expires-at',
        new Date(Date.now() + 5000).toISOString(),
        '--completion-path',
        completion,
        '--command-base64',
        encoded,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), args);
    assert.equal(JSON.parse(readFileSync(completion, 'utf8')).cleanupOwnerStatus, 'complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
