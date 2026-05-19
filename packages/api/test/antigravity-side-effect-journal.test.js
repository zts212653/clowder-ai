import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  AntigravitySideEffectJournal,
  buildAntigravitySideEffectJournalEntry,
  redactAntigravitySideEffectTarget,
} from '../dist/domains/cats/services/agents/providers/antigravity/AntigravitySideEffectJournal.js';
import { classifyAntigravityStepEffect } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-step-effects.js';

describe('F201 AntigravitySideEffectJournal', () => {
  let auditDir;

  beforeEach(() => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-side-effect-journal-'));
  });

  afterEach(() => {
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  test('appends side-effect entries in observed order and computes retry summary', () => {
    const journal = new AntigravitySideEffectJournal({
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
      invocationId: 'inv-1',
      now: () => 1770000000000,
    });

    const fileStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: 'docs/example.md' },
    };
    const mcpStep = {
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      toolCall: { toolName: 'cat_cafe_post_message', input: '{}' },
    };

    journal.observeStep({ step: fileStep, stepIndex: 3, effect: classifyAntigravityStepEffect(fileStep) });
    journal.observeStep({ step: mcpStep, stepIndex: 4, effect: classifyAntigravityStepEffect(mcpStep) });

    const entries = journal.entries();
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => [entry.stepIndex, entry.operation, entry.status]),
      [
        [3, 'write', 'done'],
        [4, 'mcp_tool', 'pending'],
      ],
    );

    const summary = journal.summary();
    assert.equal(summary.hasSideEffect, true);
    assert.equal(summary.hasCompletedSideEffect, true);
    assert.equal(summary.hasPendingOrUnknownSideEffect, true);
    assert.equal(summary.retrySafeSummary.safeToRetry, false);
    assert.equal(summary.retrySafeSummary.reason, 'unsafe_side_effect_seen');
  });

  test('builds stable idempotency keys for completed effects and dedups resume duplicates', () => {
    const journal = new AntigravitySideEffectJournal({
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
      now: () => 1770000000000,
    });
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: 'docs/example.md' },
    };
    const effect = classifyAntigravityStepEffect(step);

    const first = journal.observeStep({ step, stepIndex: 1, effect });
    const duplicate = journal.observeStep({ step, stepIndex: 9, effect });

    assert.equal(first?.idempotencyKey, duplicate?.idempotencyKey);
    assert.equal(first?.idempotencyKey.startsWith('done:code:write:'), true);
    assert.equal(journal.entries().length, 1);
    assert.equal(journal.summary().dedupedEntryCount, 1);
  });

  test('redacts sensitive targets before metadata and audit output', async () => {
    const journal = new AntigravitySideEffectJournal({
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
      auditDir,
      now: () => Date.parse('2026-05-15T16:00:00Z'),
    });
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: '/home/user/id_rsa' },
    };

    journal.observeStep({ step, stepIndex: 2, effect: classifyAntigravityStepEffect(step) });
    assert.equal(journal.entries()[0].target, '[REDACTED_TARGET]');
    assert.equal(redactAntigravitySideEffectTarget('docs/safe.md'), 'docs/safe.md');

    await journal.flushAudit();
    const auditPath = path.join(auditDir, 'side-effect-journal-2026-05-15.jsonl');
    const auditEntry = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim());
    assert.equal(auditEntry.target, '[REDACTED_TARGET]');
    assert.equal(JSON.stringify(auditEntry).includes('id_rsa'), false);
  });

  test('computes idempotency keys from raw targets before redaction', () => {
    const journal = new AntigravitySideEffectJournal({
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
      now: () => 1770000000000,
    });
    const sshStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: '/home/user/id_rsa' },
    };
    const awsStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: '/home/user/credentials' },
    };

    const sshEntry = journal.observeStep({
      step: sshStep,
      stepIndex: 2,
      effect: classifyAntigravityStepEffect(sshStep),
    });
    const awsEntry = journal.observeStep({
      step: awsStep,
      stepIndex: 3,
      effect: classifyAntigravityStepEffect(awsStep),
    });

    assert.equal(sshEntry.target, '[REDACTED_TARGET]');
    assert.equal(awsEntry.target, '[REDACTED_TARGET]');
    assert.notEqual(sshEntry.idempotencyKey, awsEntry.idempotencyKey);
    assert.equal(journal.entries().length, 2);
    assert.equal(journal.summary().dedupedEntryCount, 0);
  });

  test('derives legacy executionJournal metadata from completed journal entries', () => {
    const journal = new AntigravitySideEffectJournal({
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
    });
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: 'docs/example.md' },
    };

    journal.observeStep({ step, stepIndex: 7, effect: classifyAntigravityStepEffect(step) });

    const legacy = journal.toExecutionJournal({
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });

    assert.deepEqual(legacy, {
      approvalSent: false,
      dispatchAttempted: true,
      dispatchReturned: true,
      writebackSent: true,
    });
  });

  test('keeps pending executionJournal metadata before dispatch while journal carries the pending effect', () => {
    const journal = new AntigravitySideEffectJournal({
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
    });
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      runCommand: { commandLine: 'touch tmp/example' },
    };

    journal.observeStep({ step, stepIndex: 8, effect: classifyAntigravityStepEffect(step) });

    const legacy = journal.toExecutionJournal({
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });

    assert.deepEqual(legacy, {
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });
    assert.equal(journal.summary().hasPendingOrUnknownSideEffect, true);
  });

  test('buildAntigravitySideEffectJournalEntry creates non-empty synthetic keys for pending effects', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      runCommand: { commandLine: 'touch tmp/example' },
    };
    const entry = buildAntigravitySideEffectJournalEntry({
      context: { threadId: 'thread-1', catId: 'antig-opus', cascadeId: 'cascade-1' },
      step,
      stepIndex: 5,
      effect: classifyAntigravityStepEffect(step),
      observedAt: 1770000000000,
    });

    assert.equal(entry.idempotencyKey.startsWith('pending:shell:run_command:'), true);
    assert.notEqual(entry.idempotencyKey, '');
  });
});
