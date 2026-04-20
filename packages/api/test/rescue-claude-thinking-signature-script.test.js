import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rescueScript = resolve(__dirname, '..', '..', '..', 'scripts', 'rescue-claude-thinking-signature.mjs');

test('--session requires an argument value', () => {
  const result = spawnSync(process.execPath, [rescueScript, '--session', '--dry-run'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /--session requires a value/);
});

test('fails closed when a detected broken session cannot be repaired', (t) => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'claude-thinking-rescue-script-'));
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }));

  const projectsRoot = join(sandboxRoot, 'projects');
  mkdirSync(projectsRoot, { recursive: true });
  const transcriptPath = join(projectsRoot, 'mixed.jsonl');

  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'assistant',
      sessionId: 'mixed',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'ponder', signature: 'short-signature' },
          { type: 'text', text: 'keep visible reply' },
        ],
      },
    })}\n`,
    'utf8',
  );

  const result = spawnSync(
    process.execPath,
    [
      rescueScript,
      '--all-broken',
      '--dry-run',
      '--root-dir',
      projectsRoot,
      '--backup-dir',
      join(sandboxRoot, 'backups'),
    ],
    {
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Found 1 broken Claude session\(s\)\./);
  assert.match(result.stdout, /- mixed \(short_signature, removable thinking turns=0\)/);
  assert.match(result.stdout, /- mixed: unrescued removed=0 reason=no_safe_turns_to_strip/);
});
