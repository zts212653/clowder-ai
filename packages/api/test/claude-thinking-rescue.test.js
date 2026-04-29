// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

function buildPureThinkingAssistantTurn(sessionId, signature = 'sig-123') {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'ponder', signature }],
    },
  });
}

function buildHealthyAssistantTurn(sessionId, text = 'hello') {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function buildApiErrorTurn(sessionId) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Invalid `signature` in `thinking` block' }],
    },
  });
}

describe('ClaudeThinkingRescue', () => {
  it('findBrokenClaudeThinkingSessions returns structured session scan results', async () => {
    const { findBrokenClaudeThinkingSessions } = await import(
      '../dist/domains/cats/services/session/ClaudeThinkingRescue.js'
    );

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-thinking-rescue-api-'));
    const projectsRoot = path.join(tmp, 'projects');
    await fs.mkdir(projectsRoot, { recursive: true });

    const brokenFile = path.join(projectsRoot, 'broken.jsonl');
    await fs.writeFile(
      brokenFile,
      [
        buildPureThinkingAssistantTurn('broken'),
        buildPureThinkingAssistantTurn('broken', 'sig-456'),
        buildHealthyAssistantTurn('broken', 'keep me'),
        buildApiErrorTurn('broken'),
      ].join('\n'),
      'utf8',
    );

    const cleanFile = path.join(projectsRoot, 'clean.jsonl');
    await fs.writeFile(cleanFile, `${buildHealthyAssistantTurn('clean', 'all good')}\n`, 'utf8');

    const result = await findBrokenClaudeThinkingSessions({ rootDir: projectsRoot });

    assert.equal(result.sessions.length, 1);
    assert.deepEqual(result.sessions[0], {
      sessionId: 'broken',
      transcriptPath: brokenFile,
      removableThinkingTurns: 2,
      detectedBy: 'api_error_entry',
    });
  });

  it('findBrokenClaudeThinkingSessions detects empty thinking signatures without an API error entry', async () => {
    const { findBrokenClaudeThinkingSessions } = await import(
      '../dist/domains/cats/services/session/ClaudeThinkingRescue.js'
    );

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-thinking-rescue-api-'));
    const projectsRoot = path.join(tmp, 'projects');
    await fs.mkdir(projectsRoot, { recursive: true });

    const brokenFile = path.join(projectsRoot, 'empty-signature.jsonl');
    await fs.writeFile(brokenFile, `${buildPureThinkingAssistantTurn('empty-signature', '')}\n`, 'utf8');

    const result = await findBrokenClaudeThinkingSessions({ rootDir: projectsRoot });

    assert.equal(result.sessions.length, 1);
    assert.deepEqual(result.sessions[0], {
      sessionId: 'empty-signature',
      transcriptPath: brokenFile,
      removableThinkingTurns: 1,
      detectedBy: 'short_signature',
    });
  });

  it('rescueClaudeThinkingSessions repairs selected sessions and reports structured results', async () => {
    const { rescueClaudeThinkingSessions } = await import(
      '../dist/domains/cats/services/session/ClaudeThinkingRescue.js'
    );

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-thinking-rescue-api-'));
    const projectsRoot = path.join(tmp, 'projects');
    const backupDir = path.join(tmp, 'backups');
    await fs.mkdir(projectsRoot, { recursive: true });

    const brokenFile = path.join(projectsRoot, 'broken.jsonl');
    await fs.writeFile(
      brokenFile,
      [
        buildPureThinkingAssistantTurn('broken'),
        buildHealthyAssistantTurn('broken', 'survivor'),
        buildApiErrorTurn('broken'),
      ].join('\n'),
      'utf8',
    );

    const result = await rescueClaudeThinkingSessions({
      targets: [{ sessionId: 'broken', transcriptPath: brokenFile }],
      backupDir,
      now: 1_772_947_520_000,
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.rescuedCount, 1);
    assert.equal(result.skippedCount, 0);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].sessionId, 'broken');
    assert.equal(result.results[0].status, 'repaired');
    assert.equal(result.results[0].removedTurns, 1);
    assert.ok(result.results[0].backupPath);

    const repaired = await fs.readFile(brokenFile, 'utf8');
    assert.ok(repaired.includes('survivor'));
    assert.ok(!repaired.includes('"type":"thinking"'));
  });

  it('rescueClaudeThinkingSessions strips pure thinking turns with empty signatures', async () => {
    const { rescueClaudeThinkingSessions } = await import(
      '../dist/domains/cats/services/session/ClaudeThinkingRescue.js'
    );

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-thinking-rescue-api-'));
    const projectsRoot = path.join(tmp, 'projects');
    const backupDir = path.join(tmp, 'backups');
    await fs.mkdir(projectsRoot, { recursive: true });

    const brokenFile = path.join(projectsRoot, 'empty-signature.jsonl');
    await fs.writeFile(
      brokenFile,
      [
        buildPureThinkingAssistantTurn('empty-signature', ''),
        buildHealthyAssistantTurn('empty-signature', 'survivor'),
      ].join('\n'),
      'utf8',
    );

    const result = await rescueClaudeThinkingSessions({
      targets: [{ sessionId: 'empty-signature', transcriptPath: brokenFile }],
      backupDir,
      now: 1_772_947_520_000,
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.results[0].status, 'repaired');
    assert.equal(result.results[0].removedTurns, 1);

    const repaired = await fs.readFile(brokenFile, 'utf8');
    assert.ok(repaired.includes('survivor'));
    assert.ok(!repaired.includes('"signature":""'));
  });

  it('rescueClaudeThinkingSessions returns partial when repaired and skipped results coexist', async () => {
    const { rescueClaudeThinkingSessions } = await import(
      '../dist/domains/cats/services/session/ClaudeThinkingRescue.js'
    );

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-thinking-rescue-api-'));
    const projectsRoot = path.join(tmp, 'projects');
    const backupDir = path.join(tmp, 'backups');
    await fs.mkdir(projectsRoot, { recursive: true });

    const brokenFile = path.join(projectsRoot, 'broken.jsonl');
    await fs.writeFile(
      brokenFile,
      [
        buildPureThinkingAssistantTurn('broken'),
        buildHealthyAssistantTurn('broken', 'survivor'),
        buildApiErrorTurn('broken'),
      ].join('\n'),
      'utf8',
    );

    const result = await rescueClaudeThinkingSessions({
      targets: [
        { sessionId: 'broken', transcriptPath: brokenFile },
        { sessionId: 'missing', transcriptPath: path.join(projectsRoot, 'missing.jsonl') },
      ],
      backupDir,
      now: 1_772_947_520_000,
    });

    assert.equal(result.status, 'partial');
    assert.equal(result.rescuedCount, 1);
    assert.equal(result.skippedCount, 1);
    assert.deepEqual(
      result.results.map((entry) => ({ sessionId: entry.sessionId, status: entry.status })),
      [
        { sessionId: 'broken', status: 'repaired' },
        { sessionId: 'missing', status: 'missing' },
      ],
    );
  });
});
