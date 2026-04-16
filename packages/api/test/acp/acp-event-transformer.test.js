/**
 * ACP Event Transformer — maps AcpSessionUpdate → AgentMessage
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { transformAcpEvent } = await import(
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

  it('tool_call with "title" field (Gemini CLI v0.36 actual format) → tool_use', () => {
    // Observed in production: Gemini CLI sends {sessionUpdate, toolCallId, status, title, content, locations, kind}
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
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'cat_cafe_list_threads');
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

  it('tool_call_update → tool_use (incremental)', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolName: 'read_file',
        content: { type: 'text', text: 'file contents here' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'read_file');
    assert.equal(result.content, 'file contents here');
  });

  it('tool_call_update with "name" field (Gemini CLI compat) → tool_use', () => {
    const update = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        name: 'write_file',
        content: { type: 'text', text: 'wrote 42 bytes' },
      },
    };
    const result = transformAcpEvent(update, catId, metadata);
    assert.equal(result.type, 'tool_use');
    assert.equal(result.toolName, 'write_file');
    assert.equal(result.content, 'wrote 42 bytes');
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
