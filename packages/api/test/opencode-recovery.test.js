import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  projectSafeOpenCodeToolOutput,
  recoverOpenCodeSilentCompletion,
  resolveOpenCodeDbCandidates,
} from '../dist/domains/cats/services/agents/providers/opencode-recovery.js';

function createPartDb(dbPath, rows) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  );
  rows.forEach((row, index) => {
    insert.run(`prt_${index}`, row.messageId, row.sessionId, 1780915410601 + index, 1780915410687 + index, row.data);
  });
  db.close();
}

describe('opencode recovery boundary', () => {
  test('recovers from OPENCODE_DB before default locations', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-recovery-'));
    const dbPath = join(root, 'custom', 'opencode-custom.db');
    createPartDb(dbPath, [
      { sessionId: 'ses_env', messageId: 'msg_env', data: JSON.stringify({ type: 'text', text: 'from env db' }) },
    ]);

    const recovered = recoverOpenCodeSilentCompletion({
      sessionId: 'ses_env',
      messageId: 'msg_env',
      env: { OPENCODE_DB: dbPath },
      homeDir: join(root, 'home'),
      platform: 'linux',
    });

    assert.equal(recovered.text, 'from env db');
    assert.equal(recovered.source, 'OPENCODE_DB');
  });

  test('discovers channel database files under XDG data root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-xdg-'));
    const xdgRoot = join(root, 'xdg');
    const dbPath = join(xdgRoot, 'opencode', 'opencode-beta.db');
    createPartDb(dbPath, [
      { sessionId: 'ses_beta', messageId: 'msg_beta', data: JSON.stringify({ type: 'text', text: 'from beta db' }) },
    ]);

    const candidates = resolveOpenCodeDbCandidates({
      env: { XDG_DATA_HOME: xdgRoot },
      homeDir: join(root, 'home'),
      platform: 'linux',
    });
    assert.ok(candidates.some((candidate) => candidate.path === dbPath && candidate.source === 'xdg'));

    const recovered = recoverOpenCodeSilentCompletion({
      sessionId: 'ses_beta',
      messageId: 'msg_beta',
      env: { XDG_DATA_HOME: xdgRoot },
      homeDir: join(root, 'home'),
      platform: 'linux',
    });

    assert.equal(recovered.text, 'from beta db');
    assert.equal(recovered.source, 'xdg');
  });

  test('fails closed when db is missing or schema drifts', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-schema-'));
    const missing = recoverOpenCodeSilentCompletion({
      sessionId: 'ses_missing',
      messageId: 'msg_missing',
      env: {},
      homeDir: join(root, 'home'),
      platform: 'linux',
    });
    assert.equal(missing.text, null);
    assert.equal(missing.reason, 'missing_db');

    const driftDbPath = join(root, 'drift', 'opencode.db');
    mkdirSync(dirname(driftDbPath), { recursive: true });
    const db = new Database(driftDbPath);
    db.exec('CREATE TABLE part_v2 (data text NOT NULL);');
    db.close();

    const drift = recoverOpenCodeSilentCompletion({
      sessionId: 'ses_missing',
      messageId: 'msg_missing',
      overridePath: driftDbPath,
      env: {},
      homeDir: join(root, 'home'),
      platform: 'linux',
    });
    assert.equal(drift.text, null);
    assert.equal(drift.source, 'override');
    assert.equal(drift.reason, 'schema_unavailable');
  });

  test('skips malformed and non-text parts while joining same-message text parts', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-parts-'));
    const dbPath = join(root, 'opencode.db');
    createPartDb(dbPath, [
      { sessionId: 'ses_parts', messageId: 'msg_parts', data: '{not-json' },
      {
        sessionId: 'ses_parts',
        messageId: 'msg_parts',
        data: JSON.stringify({ type: 'reasoning', text: 'hidden reasoning' }),
      },
      { sessionId: 'ses_parts', messageId: 'msg_parts', data: JSON.stringify({ type: 'text', text: 'part A ' }) },
      { sessionId: 'ses_parts', messageId: 'msg_parts', data: JSON.stringify({ type: 'text', text: 'part B' }) },
      { sessionId: 'other', messageId: 'msg_parts', data: JSON.stringify({ type: 'text', text: 'wrong session' }) },
    ]);

    const recovered = recoverOpenCodeSilentCompletion({
      sessionId: 'ses_parts',
      messageId: 'msg_parts',
      overridePath: dbPath,
      env: {},
      homeDir: join(root, 'home'),
      platform: 'linux',
    });

    assert.equal(recovered.text, 'part A part B');
  });

  test('safe tool-output projection redacts provider tokens and absolute paths', () => {
    const projected = projectSafeOpenCodeToolOutput(
      'token=sk-review-secret-123 C:\\Users\\Alice\\secrets\\config.json /Users/alice/.ssh/id_rsa',
    );

    assert.doesNotMatch(projected, /sk-review-secret/);
    assert.doesNotMatch(projected, /C:\\Users\\Alice/);
    assert.doesNotMatch(projected, /\/Users\/alice/);
    assert.match(projected, /\[redacted/);
  });
});
