import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { readOpenCodeLocalSessions } from '../src/domains/cats/services/session/import/OpenCodeLocalSessionIndex.js';
import { inspectOpenCodeLocalSession } from '../src/domains/cats/services/session/import/OpenCodeLocalSessionInspection.js';
import { readOpenCodeImport } from '../src/domains/cats/services/session/import/OpenCodeLocalSessionReader.js';

test('OpenCode reads only capped session index metadata, accepts native ses IDs and refuses unknown IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-opencode-'));
  const path = join(root, 'opencode.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER, parent_id TEXT)',
  );
  const insert = db.prepare('INSERT INTO session VALUES(?, ?, ?, ?, NULL, NULL)');
  for (let i = 0; i < 30; i++) insert.run(`ses_test${i}`, '/project', 'Generated title is not a human first line', i);
  db.close();
  try {
    const listing = readOpenCodeLocalSessions(path, { limit: 20 });
    assert.equal(listing.sessions.length, 20);
    assert.equal(listing.sessions[0].sessionId, 'ses_test29');
    assert.equal(listing.sessions[0].firstPrompt, '');
    assert.equal(listing.limited, true);
    assert.equal(
      (await readOpenCodeImport({ path, limit: 20 })).sessions.length,
      20,
      'production process reader uses the same capped metadata',
    );
    assert.equal(readOpenCodeLocalSessions(path, { sessionId: 'ses_test0' }).sessions[0].projectPath, '/project');
    assert.throws(() => readOpenCodeLocalSessions(path, { sessionId: 'ses_unknown' }), /unavailable/);
    assert.throws(() => readOpenCodeLocalSessions(path, { limit: 201 }), /limit/);
    assert.throws(() => readOpenCodeLocalSessions(path, { sessionId: '../escape' }), /ID/);
    const reopened = new Database(path, { readonly: true });
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM session').get().n, 30);
    reopened.close();
  } finally {
    await rm(root, { recursive: true });
  }
});

test('OpenCode preflight rejects Desktop/server unfinished turns and leaves history untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-opencode-writer-'));
  const path = join(root, 'native.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER, parent_id TEXT); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
  );
  const now = Date.now();
  db.prepare('INSERT INTO session VALUES(?, ?, ?, NULL, NULL)').run('ses_f322writerfixture', '/project', now);
  db.prepare('INSERT INTO message VALUES(?, ?, ?, ?, ?)').run(
    'm',
    'ses_f322writerfixture',
    now,
    now,
    JSON.stringify({ role: 'assistant', time: { created: now } }),
  );
  try {
    await assert.rejects(
      inspectOpenCodeLocalSession(path, 'ses_f322writerfixture'),
      (error: { code?: string }) => error.code === 'SESSION_ACTIVE_WRITER',
    );
    db.prepare('UPDATE message SET data = ?').run(
      JSON.stringify({ role: 'assistant', time: { created: 1, completed: 2 } }),
    );
    assert.equal((await inspectOpenCodeLocalSession(path, 'ses_f322writerfixture')).sessionId, 'ses_f322writerfixture');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true });
  }
});

test('an old interrupted OpenCode turn is importable, while a newly updated unfinished turn remains busy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-opencode-orphan-'));
  const path = join(root, 'native.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER, parent_id TEXT); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
  );
  const old = Date.now() - 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO session VALUES(?, ?, ?, NULL, NULL)').run('ses_f322oldturn', '/project', old);
  db.prepare('INSERT INTO message VALUES(?, ?, ?, ?, ?)').run(
    'm',
    'ses_f322oldturn',
    old,
    old,
    JSON.stringify({ role: 'assistant', time: { created: old } }),
  );
  try {
    assert.equal((await inspectOpenCodeLocalSession(path, 'ses_f322oldturn')).sessionId, 'ses_f322oldturn');
    db.prepare('UPDATE message SET time_updated = ?').run(Date.now());
    await assert.rejects(
      inspectOpenCodeLocalSession(path, 'ses_f322oldturn'),
      (e: { code?: string }) => e.code === 'SESSION_ACTIVE_WRITER',
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true });
  }
});

test('recent OpenCode rows use only the first user message first non-synthetic text part, capped at 500 characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-opencode-first-text-'));
  const path = join(root, 'native.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER, parent_id TEXT); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id); CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT); CREATE INDEX part_message_id_id_idx ON part(message_id,id)',
  );
  db.prepare('INSERT INTO session VALUES(?, ?, ?, 10, NULL, NULL)').run(
    'ses_firstuser',
    '/project',
    'AI generated title',
  );
  const msg = db.prepare('INSERT INTO message VALUES(?, ?, ?, ?)');
  msg.run('assistant', 'ses_firstuser', 0, JSON.stringify({ role: 'assistant' }));
  msg.run('first', 'ses_firstuser', 1, JSON.stringify({ role: 'user' }));
  msg.run('later', 'ses_firstuser', 2, JSON.stringify({ role: 'user' }));
  const part = db.prepare('INSERT INTO part VALUES(?, ?, ?)');
  part.run('a', 'assistant', JSON.stringify({ type: 'text', text: 'Not the user' }));
  part.run('a0', 'first', JSON.stringify({ type: 'text', synthetic: true, text: 'Generated attachment instructions' }));
  part.run('a1', 'first', JSON.stringify({ type: 'file', url: 'not text' }));
  part.run('a2', 'first', JSON.stringify({ type: 'text', text: '人说的第一句'.repeat(120) }));
  part.run('a3', 'first', JSON.stringify({ type: 'text', text: 'Do not read the second text part' }));
  part.run('later', 'later', JSON.stringify({ type: 'text', text: 'Do not substitute a later message' }));
  try {
    assert.equal(
      readOpenCodeLocalSessions(path, { limit: 20 }).sessions[0].firstPrompt,
      '人说的第一句'.repeat(120).slice(0, 500),
    );
    assert.equal(
      readOpenCodeLocalSessions(path, { sessionId: 'ses_firstuser' }).sessions[0].firstPrompt,
      '',
      'preflight/bind metadata never persists list-only text',
    );
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: '<runtime-routing-context> clipped' }),
      'a2',
    );
    assert.deepEqual(
      readOpenCodeLocalSessions(path, { limit: 20 }).sessions,
      [],
      'the first input proves Cafe origin; no later part/message is read to fill the list',
    );
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'First real input' }),
      'a2',
    );
    db.exec('DROP INDEX part_message_id_id_idx');
    assert.equal(
      readOpenCodeLocalSessions(path, { limit: 20 }).sessions[0].firstPrompt,
      '',
      'a missing native index falls back instead of scanning transcript parts',
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM part').get() as { n: number }).n, 6);
  } finally {
    db.close();
    await rm(root, { recursive: true });
  }
});

test('recent OpenCode subagent sessions never displace parents and cannot be imported by pasted ID', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f322-opencode-children-'));
  const path = join(root, 'native.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER, parent_id TEXT); CREATE INDEX session_parent_idx ON session(parent_id)',
  );
  const insert = db.prepare('INSERT INTO session VALUES(?, ?, ?, ?, ?)');
  for (let i = 0; i < 3; i++) insert.run(`ses_parent${i}`, '/project', i, null, null);
  for (let i = 0; i < 30; i++) insert.run(`ses_child${i}`, '/project', 100 + i, null, 'ses_parent0');
  insert.run('ses_archived', '/project', 1000, 1000, null);
  try {
    await t.test('list budget is spent only on unarchived parents', () => {
      const listing = readOpenCodeLocalSessions(path, { limit: 2 });
      assert.deepEqual(
        listing.sessions.map((s) => s.sessionId),
        ['ses_parent2', 'ses_parent1'],
      );
      assert.equal(listing.limited, true);
      assert.equal(readOpenCodeLocalSessions(path, { limit: 20 }).limited, false);
      assert.equal(readOpenCodeLocalSessions(path, { sessionId: 'ses_parent0' }).sessions[0].sessionId, 'ses_parent0');
    });
    await t.test('pasted child ID is rejected by the native metadata reader', () => {
      assert.throws(
        () => readOpenCodeLocalSessions(path, { sessionId: 'ses_child0' }),
        (e: { code?: string }) => e.code === 'SESSION_NOT_TOP_LEVEL',
      );
    });
    await t.test('the production isolated worker preserves the child rejection', async () => {
      await assert.rejects(
        readOpenCodeImport({ path, sessionId: 'ses_child0' }),
        (e: { code?: string }) => e.code === 'SESSION_NOT_TOP_LEVEL',
      );
    });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n, 34);
  } finally {
    db.close();
    await rm(root, { recursive: true });
  }
});

test('the bounded native candidate window excludes Cafe plugin envelopes before public selection, without filtering by ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f322-opencode-origin-'));
  const path = join(root, 'native.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER, time_archived INTEGER, parent_id TEXT); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id); CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT); CREATE INDEX part_message_id_id_idx ON part(message_id,id)',
  );
  const plugin =
    '[search-mode]\nMAXIMIZE SEARCH EFFORT.\n' +
    'Known plugin instructions. '.repeat(35) +
    '\nNEVER stop at first result - be exhaustive.\n\n---\n\n';
  const insert = (id: string, time: number, text: string) => {
    db.prepare('INSERT INTO session VALUES(?, ?, ?, NULL, NULL)').run(id, '/project', time);
    db.prepare('INSERT INTO message VALUES(?, ?, 1, ?)').run(id, id, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES(?, ?, ?)').run(id, id, JSON.stringify({ type: 'text', text }));
  };
  for (let i = 0; i < 30; i++)
    insert(
      `ses_cafe${i}`,
      100 + i,
      plugin +
        (i % 2 ? '"<runtime-routing-context> clipped' : '"你是 金渐层（opencode），由 opencode 提供的 AI 猫猫。'),
    );
  insert('ses_external', 1, 'Explain what <runtime-routing-context> means');
  insert('ses_unknown', 2, '[search-mode]\nUnrecognized plugin; do not guess from later text.\nIdentity: quoted');
  insert('ses_beyondbudget', 3, '[search-mode]\n' + 'x'.repeat(2000) + '\nIdentity: outside budget');
  try {
    const result = await readOpenCodeImport({ path, limit: 20 });
    assert.deepEqual(
      result.sessions.map((s) => s.sessionId),
      ['ses_beyondbudget', 'ses_unknown', 'ses_external'],
    );
    assert.equal(result.sessions[2].firstPrompt, 'Explain what <runtime-routing-context> means');
    assert.equal(readOpenCodeLocalSessions(path, { sessionId: 'ses_cafe0' }).sessions[0].sessionId, 'ses_cafe0');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM part').get() as { n: number }).n, 33);
    for (let i = 0; i < 200; i++) insert(`ses_newcafe${i}`, 1000 + i, 'Identity: Cafe input');
    const exhausted = readOpenCodeLocalSessions(path, { limit: 20 });
    assert.deepEqual(exhausted.sessions, [], 'the finite window must not chase older rows beyond its budget');
    assert.equal(exhausted.limited, true, 'budget exhaustion remains visible even with no eligible rows');
  } finally {
    db.close();
    await rm(root, { recursive: true });
  }
});
