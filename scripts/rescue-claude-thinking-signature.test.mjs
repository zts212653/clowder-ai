import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  findBrokenSessionFiles,
  hasShortThinkingSignature,
  stripPureThinkingAssistantTurns,
} from './rescue-claude-thinking-signature.mjs';

function buildThinkingLine(sessionId, signature = 'sig-123') {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'ponder', signature }],
    },
  });
}

function buildTextLine(sessionId, text = 'hello') {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

test('hasShortThinkingSignature treats an empty thinking signature as invalid', () => {
  assert.equal(JSON.parse(buildThinkingLine('empty', '')).message.content[0].signature, '');
  assert.equal(hasShortThinkingSignature(JSON.parse(buildThinkingLine('empty', ''))), true);
});

test('stripPureThinkingAssistantTurns removes pure thinking turns with empty signatures', () => {
  const input = [
    buildThinkingLine('sess-1', ''),
    buildTextLine('sess-1', 'keep me'),
    JSON.stringify({ type: 'user', sessionId: 'sess-1', message: { role: 'user', content: 'hi' } }),
    '',
  ].join('\n');

  const result = stripPureThinkingAssistantTurns(input);

  assert.equal(result.removedCount, 1);
  assert.ok(!result.content.includes('"signature":""'));
  assert.ok(result.content.includes('keep me'));
  assert.ok(result.content.includes('"role":"user"'));
});

test('findBrokenSessionFiles finds empty-signature thinking turns without an API error entry', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-thinking-broken-'));
  const okDir = path.join(tmp, 'ok');
  const badDir = path.join(tmp, 'bad');
  await fs.mkdir(okDir, { recursive: true });
  await fs.mkdir(badDir, { recursive: true });
  await fs.writeFile(path.join(okDir, 'ok.jsonl'), `${buildTextLine('ok')}\n`, 'utf8');
  await fs.writeFile(path.join(badDir, 'bad.jsonl'), `${buildThinkingLine('bad', '')}\n`, 'utf8');

  const files = await findBrokenSessionFiles(tmp);

  assert.deepEqual(
    files.map((file) => path.basename(file)),
    ['bad.jsonl'],
  );
});
