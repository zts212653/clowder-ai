import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { A2AAgentService } from '../dist/domains/cats/services/agents/providers/A2AAgentService.js';
import {
  extractTextFromParts,
  transformA2ATaskToMessages,
} from '../dist/domains/cats/services/agents/providers/a2a-event-transform.js';

const TEST_CAT_ID = createCatId('test-a2a');

// ─── Event Transform Tests ───────────────────────────────────

describe('A2A event transform', () => {
  it('extractTextFromParts extracts text parts', () => {
    const parts = [
      { type: 'text', text: 'Hello' },
      { type: 'file', file: { name: 'doc.pdf', mimeType: 'application/pdf' } },
      { type: 'text', text: 'World' },
    ];
    assert.equal(extractTextFromParts(parts), 'Hello\nWorld');
  });

  it('extractTextFromParts handles empty array', () => {
    assert.equal(extractTextFromParts([]), '');
  });

  it('transforms completed task with text artifact', () => {
    const task = {
      id: 'task-1',
      status: 'completed',
      artifacts: [{ parts: [{ type: 'text', text: 'Result text' }] }],
    };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs.length, 2); // text + done
    assert.equal(msgs[0].type, 'text');
    assert.equal(msgs[0].content, 'Result text');
    assert.equal(msgs[1].type, 'done');
  });

  it('transforms completed task with file artifact', () => {
    const task = {
      id: 'task-1',
      status: 'completed',
      artifacts: [{ parts: [{ type: 'file', file: { name: 'photo.jpg', mimeType: 'image/jpeg' } }] }],
    };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs.length, 2); // file ref + done
    assert.ok(msgs[0].content.includes('photo.jpg'));
  });

  it('transforms completed task using history fallback', () => {
    const task = {
      id: 'task-1',
      status: 'completed',
      artifacts: [],
      history: [
        { role: 'user', parts: [{ type: 'text', text: 'question' }] },
        { role: 'agent', parts: [{ type: 'text', text: 'answer from history' }] },
      ],
    };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs[0].content, 'answer from history');
  });

  it('transforms failed task', () => {
    const task = { id: 'task-1', status: 'failed' };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, 'error');
  });

  it('transforms input-required task', () => {
    const task = { id: 'task-1', status: 'input-required' };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs[0].type, 'system_info');
  });

  it('returns empty for submitted/working tasks', () => {
    assert.equal(transformA2ATaskToMessages({ id: 't', status: 'submitted' }, TEST_CAT_ID).length, 0);
    assert.equal(transformA2ATaskToMessages({ id: 't', status: 'working' }, TEST_CAT_ID).length, 0);
  });
});

// ─── A2AAgentService Tests ───────────────────────────────────

/** Create a mock fetch that returns a canned A2A JSON-RPC response */
function mockFetch(task) {
  return async () => ({
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: '1', result: task }),
  });
}

function mockFetchError(status, statusText) {
  return async () => ({ ok: false, status, statusText, json: async () => ({}) });
}

function mockFetchRpcError(code, message) {
  return async () => ({
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: '1', error: { code, message } }),
  });
}

describe('A2AAgentService', () => {
  it('yields session_init + text + done for completed task', async () => {
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local' },
      fetchFn: mockFetch({
        id: 'task-1',
        status: 'completed',
        artifacts: [{ parts: [{ type: 'text', text: 'Hello from remote agent' }] }],
      }),
    });

    const messages = [];
    for await (const msg of service.invoke('test prompt')) {
      messages.push(msg);
    }

    assert.equal(messages[0].type, 'session_init');
    assert.equal(messages[1].type, 'text');
    assert.equal(messages[1].content, 'Hello from remote agent');
    assert.equal(messages[2].type, 'done');
  });

  it('yields error for HTTP failure', async () => {
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local' },
      fetchFn: mockFetchError(500, 'Internal Server Error'),
    });

    const messages = [];
    for await (const msg of service.invoke('test')) {
      messages.push(msg);
    }

    assert.equal(messages[1].type, 'error');
    assert.ok(messages[1].content.includes('500'));
  });

  it('yields error for JSON-RPC error', async () => {
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local' },
      fetchFn: mockFetchRpcError(-32600, 'Invalid request'),
    });

    const messages = [];
    for await (const msg of service.invoke('test')) {
      messages.push(msg);
    }

    assert.equal(messages[1].type, 'error');
    assert.ok(messages[1].content.includes('Invalid request'));
  });

  it('yields error for network failure', async () => {
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local' },
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const messages = [];
    for await (const msg of service.invoke('test')) {
      messages.push(msg);
    }

    assert.equal(messages[1].type, 'error');
    assert.ok(messages[1].content.includes('ECONNREFUSED'));
  });

  it('sends Authorization header when apiKey configured', async () => {
    let capturedHeaders;
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local', apiKey: 'test-key-123' },
      fetchFn: async (_url, init) => {
        capturedHeaders = init.headers;
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: '1', result: { id: 't', status: 'completed', artifacts: [] } }),
        };
      },
    });

    for await (const _msg of service.invoke('test')) {
      /* consume */
    }
    assert.equal(capturedHeaders['Authorization'], 'Bearer test-key-123');
  });

  it('sends correct JSON-RPC body', async () => {
    let capturedBody;
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local' },
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: '1', result: { id: 't', status: 'completed', artifacts: [] } }),
        };
      },
    });

    for await (const _msg of service.invoke('Hello A2A')) {
      /* consume */
    }
    assert.equal(capturedBody.jsonrpc, '2.0');
    assert.equal(capturedBody.method, 'tasks/send');
    assert.equal(capturedBody.params.message.role, 'user');
    assert.equal(capturedBody.params.message.parts[0].text, 'Hello A2A');
  });

  it('respects caller abort signal for cancellation', async () => {
    const controller = new AbortController();
    const service = new A2AAgentService({
      catId: TEST_CAT_ID,
      config: { url: 'http://mock.local' },
      fetchFn: async (_url, init) => {
        // Simulate slow response — abort before it completes
        controller.abort();
        init.signal.throwIfAborted();
        return { ok: true, json: async () => ({}) };
      },
    });

    const messages = [];
    for await (const msg of service.invoke('test', { signal: controller.signal })) {
      messages.push(msg);
    }

    // Should get session_init then graceful done (not error)
    assert.equal(messages[0].type, 'session_init');
    assert.equal(messages[1].type, 'done');
  });
});

describe('A2A status normalization', () => {
  it('handles SCREAMING_SNAKE_CASE status from wire format', () => {
    const task = {
      id: 'task-1',
      status: 'TASK_STATE_COMPLETED',
      artifacts: [{ parts: [{ type: 'text', text: 'result' }] }],
    };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs[0].type, 'text');
    assert.equal(msgs[1].type, 'done');
  });

  it('handles TASK_STATE_FAILED', () => {
    const task = { id: 'task-1', status: 'TASK_STATE_FAILED' };
    const msgs = transformA2ATaskToMessages(task, TEST_CAT_ID);
    assert.equal(msgs[0].type, 'error');
  });
});
