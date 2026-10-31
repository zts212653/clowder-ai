import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hasClaudeRegisteredSessionWriter } from '../src/domains/cats/services/session/import/LocalSessionInspection.js';

test('Claude live-process registry blocks the exact session without reading any conversation history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-claude-writer-'));
  try {
    await mkdir(join(root, 'sessions'));
    await writeFile(
      join(root, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'running', cwd: '/project' }),
    );
    assert.equal(await hasClaudeRegisteredSessionWriter(root, 'running'), true);
    assert.equal(await hasClaudeRegisteredSessionWriter(root, 'another'), false);
    await writeFile(
      join(root, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: 999999999, sessionId: 'running' }),
    );
    assert.equal(await hasClaudeRegisteredSessionWriter(root, 'running'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
