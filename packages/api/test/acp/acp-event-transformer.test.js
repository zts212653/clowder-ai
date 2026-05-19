/**
 * ACP Event Transformer — maps AcpSessionUpdate → AgentMessage
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { transformAcpEvent, createAcpSessionState } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js'
);

const catId = 'gemini';
const metadata = { provider: 'google', model: 'gemini-2.5-pro' };

describe('transformAcpEvent', () => {
  it('agent_message_chunk → text', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello world' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'text');
    assert.equal(result.catId, catId);
    assert.equal(result.content, 'Hello world');
    assert.deepEqual(result.metadata, metadata);
    assert.ok(result.timestamp > 0);
  });

  it('agent_thought_chunk → system_info with type=thinking', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think...' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'system_info');
    assert.equal(result.catId, catId);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.type, 'thinking');
    assert.equal(parsed.text, 'Let me think...');
  });

  it('tool_call → tool_use', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolName: 'read_file',
        toolInput: { path: '/tmp/test.txt' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'read_file');
    assert.deepEqual(result.toolInput, { path: '/tmp/test.txt' });
  });

  it('tool_call with "name" field (Gemini CLI compat) → tool_use', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        name: 'cat_cafe_post_message',
        input: { content: 'hello' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'cat_cafe_post_message');
    assert.deepEqual(result.toolInput, { content: 'hello' });
  });

  it('tool_call with "tool_name" field (snake_case compat) → tool_use', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        tool_name: 'search_evidence',
        tool_input: { query: 'test' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'search_evidence');
    assert.deepEqual(result.toolInput, { query: 'test' });
  });

  it('tool_call with "title" field (Gemini CLI v0.36 actual format) → [tool_use, tool_result] (F197 AC-A1+A7)', () => {
    // F197: Gemini CLI v0.36 packs final state into single tool_call event with
    // status=completed + content. Transformer must split into pending tool_use + final tool_result.
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-001',
        status: 'completed',
        title: 'cat_cafe_list_threads',
        content: { type: 'text', text: '{"threads":[]}' },
        locations: [],
        kind: 'tool_call',
      },
    };
    const state = createAcpSessionState();
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.ok(Array.isArray(result), 'F197: completed+content single event must split to array');
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'tool_use');
    assert.equal(result[0].toolName, 'cat_cafe_list_threads');
    assert.equal(result[1].type, 'tool_result');
    assert.equal(result[1].toolName, 'cat_cafe_list_threads');
    assert.equal(result[1].content, '{"threads":[]}');
  });

  it('tool_call with no recognizable name field → tool_use with undefined toolName', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        content: { type: 'text', text: 'some content' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, undefined);
  });

  // F197 AC-A2/A3/A6 — tool_call_update lifecycle
  it('tool_call_update without status (progress) → null (F197 AC-A2: no double-pending)', () => {
    // Progress update for a toolCallId that already has pending tool_use → don't re-emit
    const state = createAcpSessionState();
    // Pre-seed state: toolCallId tc-xx already has emitted tool_use
    state.emittedToolUseByCallId.add('tc-xx');
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-xx',
        toolName: 'read_file',
        content: { type: 'text', text: 'partial chunk...' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.equal(result, null, 'F197 KD-5: progress update must not re-emit tool_use');
  });

  it('tool_call_update(status=completed) for existing toolCallId → tool_result only (F197 AC-A2)', () => {
    const state = createAcpSessionState();
    state.emittedToolUseByCallId.add('tc-yy');
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-yy',
        status: 'completed',
        toolName: 'read_file',
        content: { type: 'text', text: 'final content' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.equal(result.type, 'tool_result', 'completed for existing pending → result only');
    assert.equal(result.toolName, 'read_file');
    assert.equal(result.content, 'final content');
  });

  it('tool_call_update(status=completed) for NEW toolCallId → [tool_use, tool_result] (F197 AC-A3 boundary)', () => {
    // Boundary: toolCallId first appears as update(completed) without prior tool_call
    const state = createAcpSessionState();
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-zz',
        status: 'completed',
        toolName: 'read_file',
        content: { type: 'text', text: 'orphan completed' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.ok(Array.isArray(result), 'AC-A3: orphan completed must split to [tool_use, tool_result]');
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'tool_use');
    assert.equal(result[1].type, 'tool_result');
    assert.equal(result[1].content, 'orphan completed');
  });

  it('tool_call_update(status=failed) for existing toolCallId → tool_result with content (F197 AC-A6f)', () => {
    const state = createAcpSessionState();
    state.emittedToolUseByCallId.add('tc-fail');
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-fail',
        status: 'failed',
        toolName: 'bash',
        content: { type: 'text', text: 'error: command not found' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.equal(result.type, 'tool_result', 'failed status routes to tool_result same as completed');
    assert.equal(result.content, 'error: command not found');
  });

  it('tool_call (no status) → tool_use only, registers toolCallId in state (F197 AC-A1)', () => {
    const state = createAcpSessionState();
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-pending',
        toolName: 'search_evidence',
        toolInput: { query: 'F197' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.equal(result.type, 'tool_use', 'no status / pending → single tool_use');
    assert.equal(result.toolName, 'search_evidence');
    assert.ok(state.emittedToolUseByCallId.has('tc-pending'), 'state must record emittedToolUse');
  });

  it('tool_call (in_progress) → tool_use only (F197 AC-A1)', () => {
    const state = createAcpSessionState();
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-running',
        status: 'in_progress',
        toolName: 'search_evidence',
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'search_evidence');
  });

  it('duplicate final update for same toolCallId → null (砚砚 PR review P1: finalEmittedByCallId guard)', () => {
    // 砚砚 PR 一审 P1: finalEmittedByCallId is written but never read.
    // ACP stream replay / duplicate final update would produce N tool_result for same toolCallId.
    // Spec KD-5 "仅一次 final tool_result" must be enforced.
    const state = createAcpSessionState();
    state.emittedToolUseByCallId.add('tc-dup');
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-dup',
        status: 'completed',
        toolName: 'read_file',
        content: { type: 'text', text: 'final content' },
      },
    };
    // First final → tool_result (single message)
    const first = transformAcpEvent(update, catId, metadata, state);
    assert.equal(first.type, 'tool_result');
    // Second final (replay/duplicate) → MUST be null, not another tool_result
    const second = transformAcpEvent(update, catId, metadata, state);
    assert.equal(second, null, 'KD-5: duplicate final update must be dropped');
  });

  it('tool_call(completed+content) replay → null on second occurrence (砚砚 PR review P1)', () => {
    // Same guard applies to tool_call(completed+content) path
    const state = createAcpSessionState();
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-dup2',
        status: 'completed',
        title: 'search_evidence',
        content: { type: 'text', text: '{"results":[]}' },
      },
    };
    const first = transformAcpEvent(update, catId, metadata, state);
    assert.ok(Array.isArray(first));
    assert.equal(first.length, 2);
    const second = transformAcpEvent(update, catId, metadata, state);
    assert.equal(second, null, 'KD-5: replayed tool_call(completed) must be dropped');
  });

  it('tool_call(completed) WITHOUT content.text → still emits [tool_use, tool_result] (cloud-1 P1#1)', () => {
    // Some tools legitimately finish without text payload (delete_file, no-op grep).
    // Pre-fix: `content?.text != null` gating left these permanently pending.
    // Post-fix: final status always emits tool_result, content '' as marker.
    const state = createAcpSessionState();
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-nocontent',
        status: 'completed',
        title: 'delete_file',
        // NO content field at all
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.ok(Array.isArray(result), 'final status must still produce pair even without content');
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'tool_use');
    assert.equal(result[1].type, 'tool_result');
    assert.equal(result[1].content, '', 'empty content marker for no-payload completion');
  });

  it('tool_call(final) follows pending tool_call(in_progress) → tool_result ONLY (cloud-1 P1#2)', () => {
    // ACP sequence: tool_call(in_progress) → tool_call(completed+content)
    // Pre-fix: second event always emitted [tool_use, tool_result] — duplicate pending.
    // Post-fix: detect emittedToolUseByCallId, emit only tool_result.
    const state = createAcpSessionState();
    // First event: pending
    const pending = transformAcpEvent(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-seq',
          status: 'in_progress',
          title: 'search_evidence',
        },
      },
      catId,
      metadata,
      state,
    );
    assert.equal(pending.type, 'tool_use');
    // Second event: same toolCallId now arrives final
    const final = transformAcpEvent(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-seq',
          status: 'completed',
          title: 'search_evidence',
          content: { type: 'text', text: '{"hits":3}' },
        },
      },
      catId,
      metadata,
      state,
    );
    assert.equal(
      final.type,
      'tool_result',
      'KD-5: same toolCallId emits tool_use once — second final must be result-only',
    );
    assert.equal(final.content, '{"hits":3}');
  });

  it('final tool_call followed by final tool_call_update for same toolCallId → second is null (cloud-1 P2)', () => {
    // Cloud reviewer flagged: even though finalEmittedByCallId is set after first
    // final, second final from different sessionUpdate kind must also be guarded.
    const state = createAcpSessionState();
    const first = transformAcpEvent(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-xfinal',
          status: 'completed',
          title: 'read_file',
          content: { type: 'text', text: 'final from tool_call' },
        },
      },
      catId,
      metadata,
      state,
    );
    assert.ok(Array.isArray(first));
    // Second: same toolCallId arrives as tool_call_update(completed) — should be dropped
    const second = transformAcpEvent(
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-xfinal',
          status: 'completed',
          toolName: 'read_file',
          content: { type: 'text', text: 'duplicate final' },
        },
      },
      catId,
      metadata,
      state,
    );
    assert.equal(second, null, 'cross-event final replay must be dropped (final tool_call → final tool_call_update)');
  });

  it('no-status content fallback removed — progress NOT promoted to final (F197 KD-6 / AC-A4)', () => {
    // Pre-fix bug: no-status content was being treated as final.
    // Post-fix: only status=completed/failed triggers tool_result; progress stays null.
    const state = createAcpSessionState();
    state.emittedToolUseByCallId.add('tc-prog');
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-prog',
        // NO status field — pre-fix would have treated this as final via content fallback
        toolName: 'search_evidence',
        content: { type: 'text', text: 'mid-stream chunk' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata, state);
    assert.equal(result, null, 'KD-6: no-status content must not be treated as final');
  });

  it('plan → system_info with type=plan', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'plan',
        content: { type: 'text', text: 'Step 1: Read file\nStep 2: Edit' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'system_info');
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.type, 'plan');
    assert.equal(parsed.text, 'Step 1: Read file\nStep 2: Edit');
  });

  it('user_message_chunk → null (skip echo)', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'echoed prompt' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result, null);
  });

  it('unknown update types → null', () => {
    for (const sessionUpdate of [
      'available_commands_update',
      'current_mode_update',
      'config_option_update',
      'session_info_update',
    ]) {
      const update = {
        sessionId: 's1',
        update: { sessionUpdate, content: { type: 'text', text: 'ignored' } },
      };
      const result = transformAcpEvent(update, catId, metadata);
      assert.equal(result, null, `Expected null for ${sessionUpdate}`);
    }
  });

  it('handles missing content gracefully', () => {
    const update = {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk' },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'text');
    assert.equal(result.content, '');
  });
});
