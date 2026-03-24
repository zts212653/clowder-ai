import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { transformDareEvent } from '../dist/domains/cats/services/agents/providers/dare-event-transform.js';

const catId = 'dare';

/** Helper: wrap data in DARE headless envelope */
function envelope(event, data, overrides = {}) {
  return {
    schema_version: 'client-headless-event-envelope.v1',
    ts: 1709500000.0,
    session_id: 'sess-abc',
    run_id: 'run-1',
    seq: 1,
    event,
    data,
    ...overrides,
  };
}

describe('transformDareEvent', () => {
  // ── session ──
  test('maps session.started → session_init', () => {
    const event = envelope('session.started', { mode: 'chat', entrypoint: 'script' });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'session_init');
    assert.strictEqual(result.sessionId, 'sess-abc');
    assert.strictEqual(result.catId, catId);
  });

  // ── tool events ──
  test('maps tool.invoke → tool_use with enriched toolInput', () => {
    const event = envelope('tool.invoke', {
      tool_name: 'read_file',
      tool_call_id: 'tc-1',
      capability_id: 'fs',
      attempt: 1,
      risk_level: 0,
      requires_approval: false,
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'tool_use');
    assert.strictEqual(result.toolName, 'read_file');
    assert.ok(result.toolInput);
    assert.strictEqual(result.toolInput.tool_call_id, 'tc-1');
    assert.strictEqual(result.toolInput.capability_id, 'fs');
  });

  test('tool.invoke forwards arguments object into toolInput', () => {
    const event = envelope('tool.invoke', {
      tool_name: 'write_file',
      tool_call_id: 'tc-2',
      capability_id: 'fs',
      arguments: { path: '/tmp/test.txt', content: 'hello' },
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.toolInput?.path, '/tmp/test.txt');
    assert.strictEqual(result.toolInput?.content, 'hello');
    assert.strictEqual(result.toolInput?.tool_call_id, 'tc-2');
  });

  test('tool.invoke without tool_call_id yields no toolInput', () => {
    const event = envelope('tool.invoke', { tool_name: 'shell' });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.toolInput, undefined);
  });

  test('maps tool.result → tool_result with output content', () => {
    const event = envelope('tool.result', {
      tool_call_id: 'tc-1',
      tool_name: 'read_file',
      success: true,
      output: 'file contents here',
      duration_ms: 42.5,
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'tool_result');
    assert.strictEqual(result.content, 'file contents here');
  });

  test('tool.result without output falls back to tool_name completed', () => {
    const event = envelope('tool.result', {
      tool_call_id: 'tc-1',
      tool_name: 'read_file',
      success: true,
      duration_ms: 42.5,
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'tool_result');
    assert.strictEqual(result.content, 'read_file completed');
  });

  test('maps tool.error → tool_result with error content', () => {
    const event = envelope('tool.error', {
      tool_call_id: 'tc-2',
      tool_name: 'write_file',
      success: false,
      error: 'Permission denied',
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'tool_result');
    assert.ok(result.content?.includes('Permission denied'));
  });

  // ── task lifecycle ──
  test('maps task.completed → text (rendered_output) + isFinal hint', () => {
    const event = envelope('task.completed', {
      task: 'say hello',
      output: { result: 'ok' },
      rendered_output: 'Hello! This is the DARE agent response.',
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'text');
    assert.strictEqual(result.content, 'Hello! This is the DARE agent response.');
  });

  test('task.completed with empty rendered_output still yields text', () => {
    const event = envelope('task.completed', {
      task: 'noop',
      output: null,
      rendered_output: '',
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'text');
    assert.strictEqual(result.content, '');
  });

  test('maps task.failed with error string → error', () => {
    const event = envelope('task.failed', {
      task: 'do something',
      error: 'Approval timed out',
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'error');
    assert.ok(result.error?.includes('Approval timed out'));
  });

  test('maps task.failed with errors array → error', () => {
    const event = envelope('task.failed', {
      task: 'do something',
      errors: ['error1', 'error2'],
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'error');
    assert.ok(result.error);
  });

  // ── approval events ──
  test('maps approval.pending → system_info', () => {
    const event = envelope('approval.pending', {
      tool_name: 'shell',
      risk_level: 2,
    });
    const result = transformDareEvent(event, catId);
    assert.ok(result);
    assert.strictEqual(result.type, 'system_info');
    assert.ok(result.content?.includes('approval'));
  });

  // ── filtering ──
  test('returns null for log events', () => {
    assert.strictEqual(transformDareEvent(envelope('log.info', { message: 'hi' }), catId), null);
    assert.strictEqual(transformDareEvent(envelope('log.header', {}), catId), null);
  });

  test('returns null for transport events', () => {
    assert.strictEqual(transformDareEvent(envelope('transport.raw', {}), catId), null);
  });

  test('returns null for model.response (no user-facing content)', () => {
    assert.strictEqual(
      transformDareEvent(envelope('model.response', { iteration: 1, has_tool_calls: false }), catId),
      null,
    );
  });

  test('returns null for non-object input', () => {
    assert.strictEqual(transformDareEvent('string', catId), null);
    assert.strictEqual(transformDareEvent(null, catId), null);
    assert.strictEqual(transformDareEvent(42, catId), null);
  });

  test('returns null for non-DARE envelope (wrong schema_version)', () => {
    const event = { schema_version: 'other.v1', event: 'task.completed', data: {} };
    assert.strictEqual(transformDareEvent(event, catId), null);
  });

  test('returns null for missing schema_version', () => {
    const event = { event: 'task.completed', data: {} };
    assert.strictEqual(transformDareEvent(event, catId), null);
  });
});
