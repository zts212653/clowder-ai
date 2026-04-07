import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Protocol layer tests ──

describe('xiaoyi-protocol: generateXiaoyiSignature', () => {
  it('produces consistent HMAC-SHA256 base64', async () => {
    const { generateXiaoyiSignature } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const sig = generateXiaoyiSignature('test-sk', '1234567890');
    assert.match(sig, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(sig, generateXiaoyiSignature('test-sk', '1234567890'), 'deterministic');
    assert.notEqual(sig, generateXiaoyiSignature('other-sk', '1234567890'), 'different SK');
    assert.notEqual(sig, generateXiaoyiSignature('test-sk', '9999999999'), 'different timestamp');
  });

  it('input is timestamp only (not ak=...&timestamp=...)', async () => {
    const { createHmac } = await import('node:crypto');
    const { generateXiaoyiSignature } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const ts = '1234567890';
    const expected = createHmac('sha256', 'sk').update(ts).digest('base64');
    assert.equal(generateXiaoyiSignature('sk', ts), expected);
  });
});

describe('xiaoyi-protocol: envelope', () => {
  it('builds correct JSON', async () => {
    const { envelope } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const msg = JSON.parse(envelope('agent-1', 'heartbeat'));
    assert.deepEqual(msg, { msgType: 'heartbeat', agentId: 'agent-1' });
  });
});

describe('xiaoyi-protocol: agentResponse', () => {
  it('wraps detail with stringified msgDetail', async () => {
    const { agentResponse } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const detail = { kind: 'test', value: 42 };
    const parsed = JSON.parse(agentResponse('agent-1', 'session-1', 'task-1', detail));
    assert.equal(parsed.msgType, 'agent_response');
    assert.equal(parsed.agentId, 'agent-1');
    assert.equal(parsed.sessionId, 'session-1');
    assert.equal(parsed.taskId, 'task-1');
    assert.equal(typeof parsed.msgDetail, 'string', 'msgDetail must be stringified');
    assert.deepEqual(JSON.parse(parsed.msgDetail), detail);
  });
});

describe('xiaoyi-protocol: artifactUpdate', () => {
  it('builds A2A artifact-update with explicit artifactId and final=false (D12)', async () => {
    const { artifactUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const art = artifactUpdate('task-1', 'art-001', 'hello', { append: false, lastChunk: true });
    assert.equal(art.jsonrpc, '2.0');
    assert.match(String(art.id), /^msg_\d+_\d+$/);
    assert.equal(art.result.taskId, 'task-1');
    assert.equal(art.result.kind, 'artifact-update');
    assert.equal(art.result.append, false);
    assert.equal(art.result.lastChunk, true);
    assert.equal(art.result.final, false, 'artifact-update must never carry final=true');
    assert.equal(art.result.artifact.artifactId, 'art-001');
    assert.equal(art.result.artifact.parts[0].kind, 'text');
    assert.equal(art.result.artifact.parts[0].text, 'hello');
  });

  it('append mode', async () => {
    const { artifactUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const art = artifactUpdate('t', 'a1', 'chunk', { append: true, lastChunk: false });
    assert.equal(art.result.append, true);
    assert.equal(art.result.lastChunk, false);
    assert.equal(art.result.final, false);
  });

  it('partKind defaults to text, reasoningText uses { kind, reasoningText } shape', async () => {
    const { artifactUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const defaultArt = artifactUpdate('t', 'a1', 'hi', { append: false, lastChunk: true });
    assert.equal(defaultArt.result.artifact.parts[0].kind, 'text', 'default is text');
    assert.equal(defaultArt.result.artifact.parts[0].text, 'hi');

    const thinkArt = artifactUpdate('t', 'a2', 'thinking', {
      append: false,
      lastChunk: true,
      partKind: 'reasoningText',
    });
    assert.equal(thinkArt.result.artifact.parts[0].kind, 'reasoningText');
    assert.equal(thinkArt.result.artifact.parts[0].reasoningText, 'thinking', 'uses reasoningText field, not text');
    assert.equal(thinkArt.result.artifact.parts[0].text, undefined, 'no text field on reasoningText part');
  });
});

describe('xiaoyi-protocol: statusUpdate', () => {
  it('working → final:false, no message field (D8)', async () => {
    const { statusUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const st = statusUpdate('task-1', 'working');
    assert.equal(st.result.final, false);
    assert.equal(st.result.status.state, 'working');
    assert.equal(st.result.status.message, undefined, 'D8: no message field');
  });

  it('completed → final:true (close frame)', async () => {
    const { statusUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const st = statusUpdate('task-1', 'completed');
    assert.equal(st.result.final, true);
    assert.equal(st.result.status.state, 'completed');
    assert.equal(st.result.status.message, undefined, 'D8: no message field');
  });

  it('failed → final:true', async () => {
    const { statusUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const st = statusUpdate('task-1', 'failed');
    assert.equal(st.result.final, true);
  });

  it('optional message param adds structured message to status', async () => {
    const { statusUpdate } = await import('../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js');
    const st = statusUpdate('task-1', 'working', 'processing…');
    assert.deepEqual(st.result.status.message, { parts: [{ kind: 'text', text: 'processing…' }] });
  });
});

describe('xiaoyi-protocol: message ID uniqueness', () => {
  it('consecutive calls produce unique IDs', async () => {
    const { artifactUpdate, statusUpdate } = await import(
      '../dist/infrastructure/connectors/adapters/xiaoyi-protocol.js'
    );
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      ids.add(artifactUpdate('t', `a${i}`, 'x', { append: false, lastChunk: false }).id);
      ids.add(statusUpdate('t', 'working').id);
    }
    assert.equal(ids.size, 20, 'all 20 IDs must be unique');
  });
});
