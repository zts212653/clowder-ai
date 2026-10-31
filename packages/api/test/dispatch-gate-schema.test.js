/**
 * F193-E1: Dispatch Gate Schema Validation Tests
 *
 * Tests REAL schemas — not copies. Imports:
 * - MCP: createTaskInputSchema / updateTaskInputSchema from callback-tools.ts
 * - API: refineDispatchGate from callback-task-routes.ts
 *
 * These tests lock the status-dependent refine rules that were missed
 * in R1 (API create had no refine) and R2 (dispatchedMessageId not enforced).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

// --- Import REAL schemas ---

// MCP schemas (exported from callback-tools.ts)
const { createTaskInputSchema, updateTaskInputSchema } = await import('../../mcp-server/dist/tools/callback-tools.js');

// API schemas (exported @internal from callback-task-routes.ts)
const { createTaskSchema: apiCreateTaskSchema, updateTaskSchema: apiUpdateTaskSchema } = await import(
  '../dist/routes/callback-task-routes.js'
);

// Wrap MCP schemas in z.object for safeParse testing
const mcpCreateSchema = z.object(createTaskInputSchema);
const mcpUpdateSchema = z.object(updateTaskInputSchema);

describe('Dispatch Gate — REAL MCP Schema (F193-E1)', () => {
  describe('MCP create_task', () => {
    it('rejects dispatched without dispatchedMessageId', () => {
      const result = mcpCreateSchema.safeParse({
        title: 'Fix F193 bug',
        dispatchGate: {
          status: 'dispatched',
          dispatchedThreadId: 'thread_f193',
          // missing dispatchedMessageId
        },
      });
      assert.equal(result.success, false, 'should reject dispatched missing messageId');
    });

    it('rejects dispatched without dispatchedThreadId', () => {
      const result = mcpCreateSchema.safeParse({
        title: 'Fix F193 bug',
        dispatchGate: {
          status: 'dispatched',
          dispatchedMessageId: 'msg-123',
          // missing dispatchedThreadId
        },
      });
      assert.equal(result.success, false, 'should reject dispatched missing threadId');
    });

    it('rejects not_dispatched without reason', () => {
      const result = mcpCreateSchema.safeParse({
        title: 'Fix F193 bug',
        dispatchGate: {
          status: 'not_dispatched',
          // missing reason
        },
      });
      assert.equal(result.success, false, 'should reject not_dispatched missing reason');
    });

    it('accepts dispatched with both trace IDs', () => {
      const result = mcpCreateSchema.safeParse({
        title: 'Fix F193 bug',
        dispatchGate: {
          status: 'dispatched',
          dispatchedThreadId: 'thread_f193',
          dispatchedMessageId: 'msg-123',
        },
      });
      assert.equal(result.success, true, 'should accept valid dispatched');
    });

    it('accepts not_dispatched with reason', () => {
      const result = mcpCreateSchema.safeParse({
        title: 'Fix F193 bug',
        dispatchGate: {
          status: 'not_dispatched',
          reason: 'Will fix in current scope',
        },
      });
      assert.equal(result.success, true, 'should accept valid not_dispatched');
    });

    it('accepts omitted dispatchGate (no gate = allowed, handler adds missing)', () => {
      const result = mcpCreateSchema.safeParse({
        title: 'Fix F193 bug',
      });
      assert.equal(result.success, true, 'should accept no dispatchGate');
    });
  });

  describe('MCP update_task', () => {
    it('rejects dispatched without dispatchedMessageId', () => {
      const result = mcpUpdateSchema.safeParse({
        taskId: 'task-1',
        dispatchGate: {
          status: 'dispatched',
          dispatchedThreadId: 'thread_f193',
          // missing dispatchedMessageId
        },
      });
      assert.equal(result.success, false, 'should reject dispatched missing messageId');
    });

    it('rejects not_dispatched without reason', () => {
      const result = mcpUpdateSchema.safeParse({
        taskId: 'task-1',
        dispatchGate: {
          status: 'not_dispatched',
          // missing reason
        },
      });
      assert.equal(result.success, false, 'should reject not_dispatched missing reason');
    });

    it('rejects missing status (only dispatched/not_dispatched for update)', () => {
      const result = mcpUpdateSchema.safeParse({
        taskId: 'task-1',
        dispatchGate: {
          status: 'missing',
        },
      });
      assert.equal(result.success, false, 'should reject missing status on update');
    });

    it('accepts dispatched with both trace IDs', () => {
      const result = mcpUpdateSchema.safeParse({
        taskId: 'task-1',
        dispatchGate: {
          status: 'dispatched',
          dispatchedThreadId: 'thread_f193',
          dispatchedMessageId: 'msg-456',
        },
      });
      assert.equal(result.success, true, 'should accept valid dispatched');
    });
  });
});

describe('Dispatch Gate — REAL API createTaskSchema (F193-E1)', () => {
  it('rejects not_dispatched without reason', () => {
    const result = apiCreateTaskSchema.safeParse({
      title: 'Fix F193 bug',
      dispatchGate: { status: 'not_dispatched' },
    });
    assert.equal(result.success, false, 'API create should reject not_dispatched w/o reason');
  });

  it('rejects dispatched without dispatchedMessageId', () => {
    const result = apiCreateTaskSchema.safeParse({
      title: 'Fix F193 bug',
      dispatchGate: { status: 'dispatched', dispatchedThreadId: 'thread_f193' },
    });
    assert.equal(result.success, false, 'API create should reject dispatched w/o messageId');
  });

  it('rejects dispatched without dispatchedThreadId', () => {
    const result = apiCreateTaskSchema.safeParse({
      title: 'Fix F193 bug',
      dispatchGate: { status: 'dispatched', dispatchedMessageId: 'msg-1' },
    });
    assert.equal(result.success, false, 'API create should reject dispatched w/o threadId');
  });

  it('accepts dispatched with both trace IDs', () => {
    const result = apiCreateTaskSchema.safeParse({
      title: 'Fix F193 bug',
      dispatchGate: {
        status: 'dispatched',
        dispatchedThreadId: 'thread_f193',
        dispatchedMessageId: 'msg-1',
      },
    });
    assert.equal(result.success, true, 'API create should accept valid dispatched');
  });

  it('accepts missing status (system-set)', () => {
    const result = apiCreateTaskSchema.safeParse({
      title: 'Fix F193 bug',
      dispatchGate: { status: 'missing' },
    });
    assert.equal(result.success, true, 'API create should accept missing (system-set)');
  });
});

describe('Dispatch Gate — REAL API updateTaskSchema (F193-E1)', () => {
  it('rejects dispatched without dispatchedMessageId', () => {
    const result = apiUpdateTaskSchema.safeParse({
      taskId: 'task-1',
      dispatchGate: { status: 'dispatched', dispatchedThreadId: 'thread_f193' },
    });
    assert.equal(result.success, false, 'API update should reject dispatched w/o messageId');
  });

  it('rejects not_dispatched without reason', () => {
    const result = apiUpdateTaskSchema.safeParse({
      taskId: 'task-1',
      dispatchGate: { status: 'not_dispatched' },
    });
    assert.equal(result.success, false, 'API update should reject not_dispatched w/o reason');
  });

  it('accepts dispatched with both trace IDs', () => {
    const result = apiUpdateTaskSchema.safeParse({
      taskId: 'task-1',
      dispatchGate: {
        status: 'dispatched',
        dispatchedThreadId: 'thread_f193',
        dispatchedMessageId: 'msg-2',
      },
    });
    assert.equal(result.success, true, 'API update should accept valid dispatched');
  });

  it('accepts not_dispatched with reason', () => {
    const result = apiUpdateTaskSchema.safeParse({
      taskId: 'task-1',
      dispatchGate: { status: 'not_dispatched', reason: 'scope' },
    });
    assert.equal(result.success, true, 'API update should accept valid not_dispatched');
  });
});
