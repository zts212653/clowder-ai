import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AuditLogger } from '../dist/domains/cats/services/agents/providers/antigravity/executors/AuditLogger.js';

describe('AuditLogger', () => {
  let logDir;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {}
  });

  test('appends one JSON line per execution', async () => {
    const logger = new AuditLogger(logDir);
    await logger.record({
      tool: 'run_command',
      cascadeId: 'c1',
      stepIndex: 0,
      input: { commandLine: 'echo hi', cwd: '/tmp' },
      result: { status: 'success', output: { exitCode: 0 }, stdout: 'hi\n', exitCode: 0, durationMs: 5 },
      timestamp: new Date('2026-04-17T10:00:00Z'),
    });
    const file = fs.readFileSync(path.join(logDir, 'native-audit-2026-04-17.jsonl'), 'utf8');
    const entry = JSON.parse(file.trim());
    assert.equal(entry.tool, 'run_command');
    assert.equal(entry.cascadeId, 'c1');
    assert.equal(entry.stepIndex, 0);
    assert.equal(entry.result.exitCode, 0);
    assert.equal(entry.timestamp, '2026-04-17T10:00:00.000Z');
  });

  test('rotates file by UTC date', async () => {
    const logger = new AuditLogger(logDir);
    await logger.record({
      tool: 'run_command',
      cascadeId: 'c1',
      stepIndex: 0,
      input: {},
      result: { status: 'refused', reason: 'test' },
      timestamp: new Date('2026-04-17T23:59:59Z'),
    });
    await logger.record({
      tool: 'run_command',
      cascadeId: 'c2',
      stepIndex: 0,
      input: {},
      result: { status: 'refused', reason: 'test' },
      timestamp: new Date('2026-04-18T00:00:01Z'),
    });
    const files = fs.readdirSync(logDir).sort();
    assert.deepEqual(files, ['native-audit-2026-04-17.jsonl', 'native-audit-2026-04-18.jsonl']);
  });

  test('appends to existing file without overwriting', async () => {
    const logger = new AuditLogger(logDir);
    const ts = new Date('2026-04-17T10:00:00Z');
    await logger.record({
      tool: 'x',
      cascadeId: 'a',
      stepIndex: 0,
      input: {},
      result: { status: 'refused', reason: 'r' },
      timestamp: ts,
    });
    await logger.record({
      tool: 'y',
      cascadeId: 'b',
      stepIndex: 1,
      input: {},
      result: { status: 'refused', reason: 'r' },
      timestamp: ts,
    });
    const lines = fs.readFileSync(path.join(logDir, 'native-audit-2026-04-17.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).tool, 'x');
    assert.equal(JSON.parse(lines[1]).tool, 'y');
  });
});
