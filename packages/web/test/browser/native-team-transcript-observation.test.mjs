import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readNativeToolObservations } from './native-team-transcript-observation.mjs';

test('full journal scope rejects another thread, cat or invocation and retains complete native content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pr1519-journal-observer-'));
  try {
    const folder = path.join(root, 'data/transcripts/threads/t/codex/sessions/s');
    await fs.mkdir(folder, { recursive: true });
    const row = {
      threadId: 't',
      catId: 'codex',
      invocationId: 'a',
      event: {
        type: 'tool_result',
        catId: 'codex',
        toolName: 'mcp:test/tool',
        toolUseId: 'u',
        timestamp: 12,
        toolResultStatus: 'ok',
        content: 'x'.repeat(2049),
      },
    };
    await fs.writeFile(
      path.join(folder, 'events.live.jsonl'),
      `${[
        row,
        { ...row, threadId: 'foreign' },
        { ...row, catId: 'pi' },
        { ...row, invocationId: 'foreign' },
        { ...row, event: { ...row.event, catId: 'pi' } },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')}\n{"partial`,
    );
    const result = await readNativeToolObservations(root, 't', [
      { type: 'assistant', catId: 'codex', lifecycle: { invocationId: 'a' } },
    ]);
    assert.equal(result.events.size, 1);
    assert.equal(result.events.get('a').length, 1);
    assert.equal(result.events.get('a')[0].detail.length, 2049);
    assert.equal(result.sources.length, 1);
    assert.match(result.sources[0].sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(readNativeToolObservations(root, '../foreign', []));
    await fs.writeFile(path.join(folder, 'events.live.jsonl'), 'malformed\n');
    await assert.rejects(
      readNativeToolObservations(root, 't', [{ type: 'assistant', catId: 'codex', lifecycle: { invocationId: 'a' } }]),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
