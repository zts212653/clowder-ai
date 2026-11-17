import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  extractOpenCodeMessageRef,
  recoverOpenCodeSilentCompletion,
} from '../dist/domains/cats/services/agents/providers/opencode-recovery.js';

const capture = JSON.parse(readFileSync(new URL('./fixtures/opencode-2.0.28/captured.json', import.meta.url), 'utf8'));
const recoveryDbRoots = new Set();

after(() => {
  for (const root of recoveryDbRoots) rmSync(root, { recursive: true, force: true });
});

function createMessageDb(rows) {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-v2-'));
  recoveryDbRoots.add(root);
  const dbPath = join(root, 'opencode.db');
  const db = new Database(dbPath);
  // OpenCode 2.0.28 session_message columns; no real session history is included.
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
  rows.forEach((row, index) => {
    insert.run(row.id, row.sessionId, row.type, index, index, index, row.data);
  });
  db.close();
  return { overridePath: dbPath, env: {}, homeDir: root, platform: 'linux' };
}

test('real 2.0.28 captures bind distinct turns and reasoning to their exact persisted assistant message', () => {
  const options = createMessageDb(
    capture.runs.flatMap((run) =>
      run.messages.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        data: JSON.stringify(row.data),
      })),
    ),
  );
  capture.runs.forEach((run) => {
    const ref = extractOpenCodeMessageRef(run.events[0]);
    assert.deepEqual(ref, { sessionId: run.messages[0].session_id, messageId: run.messages[0].id });
    assert.equal(recoverOpenCodeSilentCompletion({ ...options, ...ref }).text, 'Hi');
  });
});

test('extracts exact assistant references from known OpenCode part events without requiring step_start', () => {
  ['step_start', 'text', 'reasoning', 'tool_use', 'step_finish'].forEach((type) => {
    assert.deepEqual(
      extractOpenCodeMessageRef({ type, sessionID: 'ses_current', part: { messageID: 'msg_current' } }),
      { sessionId: 'ses_current', messageId: 'msg_current' },
      type,
    );
  });
  assert.equal(
    extractOpenCodeMessageRef({ type: 'user', sessionID: 'ses_current', part: { messageID: 'msg_user' } }),
    null,
  );
  assert.equal(extractOpenCodeMessageRef({ type: 'error', sessionID: 'ses_current', messageID: 'msg_error' }), null);
});

test('distinguishes conflicting assistant identities from absent references', () => {
  ['step_start', 'text', 'reasoning', 'tool_use', 'step_finish'].forEach((type) => {
    ['sessionID', 'messageID'].forEach((field) => {
      assert.equal(
        extractOpenCodeMessageRef({
          type,
          sessionID: 'ses_current',
          messageID: 'msg_current',
          part: { sessionID: 'ses_current', messageID: 'msg_current', [field]: 'conflicting_id' },
        }),
        'conflict',
        `${type}: ${field}`,
      );
    });
  });
});

test('recovers only the exact 2.x assistant message text, preserving content order', () => {
  const options = createMessageDb([
    {
      id: 'msg_current',
      sessionId: 'ses_current',
      type: 'assistant',
      data: JSON.stringify({
        content: [
          { type: 'reasoning', text: 'hidden reasoning' },
          { type: 'text', text: 'part A ' },
          { type: 'tool', text: 'tool data' },
          { type: 'text', text: 'part B' },
        ],
      }),
    },
    {
      id: 'msg_newer',
      sessionId: 'ses_current',
      type: 'assistant',
      data: JSON.stringify({ content: [{ type: 'text', text: 'wrong turn' }] }),
    },
    {
      id: 'msg_other',
      sessionId: 'ses_other',
      type: 'assistant',
      data: JSON.stringify({ content: [{ type: 'text', text: 'wrong session' }] }),
    },
    {
      id: 'msg_user',
      sessionId: 'ses_current',
      type: 'user',
      data: JSON.stringify({ content: [{ type: 'text', text: 'user input' }] }),
    },
  ]);
  const recovered = recoverOpenCodeSilentCompletion({ ...options, sessionId: 'ses_current', messageId: 'msg_current' });
  assert.equal(recovered.text, 'part A part B');
  assert.equal(recovered.source, 'override');
  [
    { sessionId: 'ses_other', messageId: 'msg_current' },
    { sessionId: 'ses_current', messageId: 'msg_missing' },
    { sessionId: 'ses_current', messageId: 'msg_user' },
  ].forEach((ref) => {
    assert.equal(recoverOpenCodeSilentCompletion({ ...options, ...ref }).reason, 'no_text');
  });
  assert.equal(recoverOpenCodeSilentCompletion({ ...options, sessionId: 'ses_current' }).reason, 'missing_ref');
});

[
  ['reasoning only', JSON.stringify({ content: [{ type: 'reasoning', text: 'hidden' }] })],
  ['empty content', JSON.stringify({ content: [] })],
  ['malformed JSON', '{not-json'],
].forEach(([label, data]) => {
  test(`2.x ${label} returns no_text rather than schema_unavailable`, () => {
    const options = createMessageDb([{ id: 'msg_current', sessionId: 'ses_current', type: 'assistant', data }]);
    assert.equal(
      recoverOpenCodeSilentCompletion({ ...options, sessionId: 'ses_current', messageId: 'msg_current' }).reason,
      'no_text',
    );
  });
});

test('prefers v2 text and still reads exact legacy parts when both tables exist', () => {
  const options = createMessageDb([
    {
      id: 'msg_current',
      sessionId: 'ses_current',
      type: 'assistant',
      data: JSON.stringify({ content: [{ type: 'text', text: 'v2 answer' }] }),
    },
  ]);
  const db = new Database(options.overridePath);
  db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)');
  const insert = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)');
  insert.run('ses_current', 'msg_current', 1, JSON.stringify({ type: 'text', text: 'stale part' }));
  insert.run('ses_current', 'msg_legacy', 2, JSON.stringify({ type: 'text', text: 'legacy answer' }));
  db.close();
  assert.equal(
    recoverOpenCodeSilentCompletion({ ...options, sessionId: 'ses_current', messageId: 'msg_current' }).text,
    'v2 answer',
  );
  assert.equal(
    recoverOpenCodeSilentCompletion({ ...options, sessionId: 'ses_current', messageId: 'msg_legacy' }).text,
    'legacy answer',
  );
});

['assistant', 'user'].forEach((type) => {
  test(`an existing v2 ${type} row prevents stale legacy text from being recovered`, () => {
    const options = createMessageDb([
      { id: 'msg_current', sessionId: 'ses_current', type, data: JSON.stringify({ content: [] }) },
    ]);
    const db = new Database(options.overridePath);
    db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'ses_current',
      'msg_current',
      1,
      JSON.stringify({ type: 'text', text: 'stale legacy text' }),
    );
    db.close();
    const recovered = recoverOpenCodeSilentCompletion({
      ...options,
      sessionId: 'ses_current',
      messageId: 'msg_current',
    });
    assert.equal(recovered.text, null);
    assert.equal(recovered.reason, 'no_text');
  });
});
