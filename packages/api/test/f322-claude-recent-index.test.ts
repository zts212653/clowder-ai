import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readClaudeRecentSessionIndex } from '../src/domains/cats/services/session/import/ClaudeRecentSessionIndex.js';

const id1 = '019aaaaa-1111-7111-8111-111111111111';
const id2 = '019aaaaa-1111-7111-8111-222222222222';
const entry = (sessionId: string, timestamp: number, display: string) => ({
  sessionId,
  timestamp,
  display,
  project: '/original',
});
test('a Cafe-origin first entry excludes that Claude session even when later human entries exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-claude-human-'));
  try {
    await writeFile(
      join(root, 'history.jsonl'),
      [
        entry(id1, 1, '<runtime-routing-context> clipped…'),
        entry(id1, 2, '整理发布说明\n补充细节'),
        entry(id1, 3, '第二次请求'),
      ]
        .map(JSON.stringify)
        .join('\n'),
    );
    assert.deepEqual((await readClaudeRecentSessionIndex(20, root)).sessions, []);
  } finally {
    await rm(root, { recursive: true });
  }
});
test('Claude listing reads the CLI prompt index, retaining the first indexed prompt and recent ordering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-claude-index-'));
  try {
    await mkdir(join(root, 'projects'));
    await writeFile(join(root, 'projects', 'unreadable-transcript.jsonl'), 'not metadata');
    await writeFile(
      join(root, 'history.jsonl'),
      [entry(id1, 1, 'Fix login'), entry(id2, 2, 'Review CSS'), entry(id1, 3, 'Identity: quoted later')]
        .map(JSON.stringify)
        .join('\n') + '\n',
    );
    const result = await readClaudeRecentSessionIndex(2, root);
    assert.equal(result.sessions.length, 2);
    assert.deepEqual(
      result.sessions.map((s) => s.sessionId),
      [id1, id2],
    );
    assert.equal(result.sessions[0].firstPrompt, 'Fix login');
    assert.equal(result.sessions[0].lastActivityAt, 3);
    assert.equal(result.sessions[0].turnCount, null, 'CLI commands are not model rounds');
    assert.equal(result.sessions[0].projectPath, '/original');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('large indexes use a bounded tail and do not pass its first visible command off as the session’s first prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-claude-budget-'));
  try {
    const prefix = JSON.stringify(entry(id1, 1, 'Original beyond read budget')) + '\n';
    const padding = JSON.stringify({ ignored: 'x'.repeat(64000) }) + '\n';
    await writeFile(
      join(root, 'history.jsonl'),
      prefix + padding.repeat(40) + JSON.stringify(entry(id1, 3, 'Recent indexed prompt')) + '\n',
    );
    const result = await readClaudeRecentSessionIndex(20, root);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.limited, true);
    assert.equal(result.sessions[0].firstPrompt, '');
    assert.equal(result.sessions[0].recentPrompt, 'Recent indexed prompt');
    await writeFile(join(root, 'history.jsonl'), JSON.stringify(entry(id2, 4, 'A new session')) + '\n');
    assert.equal(
      (await readClaudeRecentSessionIndex(1, root)).sessions[0].sessionId,
      id2,
      'refresh must read current native index',
    );
    await writeFile(
      join(root, 'history.jsonl'),
      JSON.stringify(entry(id1, 5, '猫'.repeat(23000))) + '\n' + JSON.stringify(entry(id2, 6, 'Small entry')) + '\n',
    );
    const byteLimited = await readClaudeRecentSessionIndex(20, root);
    assert.equal(byteLimited.sessions.length, 1, 'the entry budget counts UTF-8 bytes, including Chinese');
    assert.equal(byteLimited.sessions[0].sessionId, id2);
    assert.equal(byteLimited.limited, true);
  } finally {
    await rm(root, { recursive: true });
  }
});
