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

// ── Adapter tests (non-streaming append accumulation model) ──

describe('XiaoyiAdapter: non-streaming append accumulation', () => {
  const mkLog = () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return this;
    },
  });

  const mkOpts = () => ({ agentId: 'agent-1', ak: 'ak', sk: 'sk' });

  function mkInbound(taskId, sessionId, text) {
    return JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/stream',
      id: `msg-${taskId}`,
      params: {
        id: taskId,
        sessionId,
        message: { role: 'user', parts: [{ kind: 'text', text }] },
      },
    });
  }

  /** Helper: extract parsed msgDetail from a sent WS frame */
  function parseDetail(frame) {
    return JSON.parse(JSON.parse(JSON.stringify(frame)).msgDetail);
  }

  /** Helper: collect sent frames */
  function captureSent(adapter) {
    const sent = [];
    adapter.ws.send = (_p, payload) => sent.push(JSON.parse(payload));
    return sent;
  }

  it('inbound → sendPlaceholder → sendReply → onDeliveryBatchDone lifecycle', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    const received = [];
    adapter.onMsg = async (msg) => received.push(msg);

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'hello'), 'primary');
    assert.equal(received.length, 1);
    assert.equal(received[0].chatId, 'agent-1:sess-1');
    assert.equal(received[0].senderId, 'owner:agent-1');

    // sendPlaceholder returns '' (no streaming artifacts)
    const artId = await adapter.sendPlaceholder('agent-1:sess-1', '...');
    assert.equal(artId, '', 'non-streaming: returns empty string');

    // Should send status-update(working) + reasoningText thinking bubble
    const details = sent.map((f) => parseDetail(f));
    assert.ok(details.some((d) => d.result?.kind === 'status-update' && d.result?.status?.state === 'working'));
    assert.ok(
      details.some(
        (d) =>
          d.result?.kind === 'artifact-update' &&
          d.result?.artifact?.parts?.[0]?.kind === 'reasoningText' &&
          d.result?.artifact?.parts?.[0]?.reasoningText === '',
      ),
      'thinking bubble uses reasoningText partKind',
    );

    sent.length = 0;

    // sendReply — first cat uses append=false
    await adapter.sendReply('agent-1:sess-1', 'world');
    const replyDetail = parseDetail(sent[0]);
    assert.equal(replyDetail.result.kind, 'artifact-update');
    assert.equal(replyDetail.result.artifact.artifactId, 'task-1:2', 'seq 2 (thinkId took seq 1)');
    assert.equal(replyDetail.result.artifact.parts[0].text, 'world');
    assert.equal(replyDetail.result.append, false, 'first cat: append=false');
    assert.equal(replyDetail.result.lastChunk, true);
    assert.equal(replyDetail.result.final, false, 'artifact never carries final');

    sent.length = 0;

    // Close frame via signal
    await adapter.onDeliveryBatchDone('agent-1:sess-1', true);
    const closeDetail = parseDetail(sent[0]);
    assert.equal(closeDetail.result.kind, 'status-update');
    assert.equal(closeDetail.result.status.state, 'completed');
    assert.equal(closeDetail.result.final, true, 'close frame has final=true');

    await adapter.stopStream();
  });

  it('append accumulation: first sendReply append=false, rest append=true with separator', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    adapter.onMsg = async () => {};

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'go'), 'primary');

    await adapter.sendReply('agent-1:sess-1', 'Cat A');
    await adapter.sendReply('agent-1:sess-1', 'Cat B');
    await adapter.sendReply('agent-1:sess-1', 'Cat C');

    const artifacts = sent.map((f) => parseDetail(f)).filter((d) => d.result?.kind === 'artifact-update');
    assert.equal(artifacts.length, 3);

    // Unique artifactIds
    const artIds = artifacts.map((a) => a.result.artifact.artifactId);
    assert.equal(new Set(artIds).size, 3, 'all artifactIds must be unique');

    // First cat: append=false, plain text
    assert.equal(artifacts[0].result.append, false, 'first cat: append=false');
    assert.equal(artifacts[0].result.artifact.parts[0].text, 'Cat A');

    // Second cat: append=true, with separator prefix
    assert.equal(artifacts[1].result.append, true, 'second cat: append=true');
    assert.equal(artifacts[1].result.artifact.parts[0].text, '\n\n---\n\nCat B');

    // Third cat: append=true, with separator prefix
    assert.equal(artifacts[2].result.append, true, 'third cat: append=true');
    assert.equal(artifacts[2].result.artifact.parts[0].text, '\n\n---\n\nCat C');

    await adapter.stopStream();
  });

  it('onDeliveryBatchDone(chainDone=false) is a no-op', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    adapter.onMsg = async () => {};

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'hello'), 'primary');
    await adapter.sendReply('agent-1:sess-1', 'partial');
    sent.length = 0;

    await adapter.onDeliveryBatchDone('agent-1:sess-1', false);
    assert.equal(sent.length, 0, 'chainDone=false should not send anything');

    // Task should still be active — can still send
    await adapter.sendReply('agent-1:sess-1', 'more');
    assert.equal(sent.length, 1, 'should still accept sendReply');

    await adapter.stopStream();
  });

  it('P2-1 regression: partial success + later failure still closes task and dequeues', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    const dispatched = [];
    adapter.onMsg = async (msg) => dispatched.push(msg.taskId);

    // Queue two tasks on same session
    adapter.handleInbound(mkInbound('task-A', 'sess-1', 'msg1'), 'primary');
    adapter.handleInbound(mkInbound('task-B', 'sess-1', 'msg2'), 'primary');
    assert.deepEqual(dispatched, ['task-A'], 'task-B queued behind A');

    // Cat A succeeds — sends reply
    await adapter.sendReply('agent-1:sess-1', 'Cat A ok');
    // Cat B fails — no sendReply, but chain is done
    sent.length = 0;
    await adapter.onDeliveryBatchDone('agent-1:sess-1', true);

    // Task A should close with completed (has artifact from Cat A)
    const closeDetail = parseDetail(sent[0]);
    assert.equal(closeDetail.result.kind, 'status-update');
    assert.equal(closeDetail.result.status.state, 'completed');
    assert.equal(closeDetail.result.final, true, 'close frame has final=true');

    // Task B should dispatch after A closes
    assert.deepEqual(dispatched, ['task-A', 'task-B'], 'task-B dispatched after failed close');

    await adapter.stopStream();
  });

  it('P3-P1: all cats fail (no artifact) → task closes with failed state', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    adapter.onMsg = async () => {};

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'go'), 'primary');

    // Placeholder sent but NO sendReply (all cats failed)
    await adapter.sendPlaceholder('agent-1:sess-1', '...');
    sent.length = 0;

    // Signal chain done — no artifact was ever produced
    await adapter.onDeliveryBatchDone('agent-1:sess-1', true);

    const closeDetail = parseDetail(sent[0]);
    assert.equal(closeDetail.result.kind, 'status-update');
    assert.equal(closeDetail.result.status.state, 'failed', 'no artifact → failed, not completed');
    assert.equal(closeDetail.result.final, true);

    await adapter.stopStream();
  });

  it('dedup prevents double processing of same task', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    adapter.ws.send = () => {};
    const received = [];
    adapter.onMsg = async (msg) => received.push(msg);

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'first'), 'primary');
    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'dupe'), 'backup');
    assert.equal(received.length, 1, 'duplicate should be dropped');

    await adapter.stopStream();
  });

  it('ignores messages for wrong agentId', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    adapter.ws.send = () => {};
    const received = [];
    adapter.onMsg = async (msg) => received.push(msg);

    adapter.handleInbound(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/stream',
        agentId: 'other-agent',
        params: { id: 'task-1', sessionId: 'sess-1', message: { parts: [{ kind: 'text', text: 'hi' }] } },
      }),
      'primary',
    );
    assert.equal(received.length, 0);

    await adapter.stopStream();
  });

  it('tasks/cancel purges session state', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    adapter.ws.send = () => {};
    adapter.onMsg = async () => {};

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'hi'), 'primary');
    await adapter.sendPlaceholder('agent-1:sess-1', '...');

    adapter.handleInbound(JSON.stringify({ method: 'tasks/cancel', params: { sessionId: 'sess-1' } }), 'primary');

    const warns = [];
    adapter.log = { ...mkLog(), warn: (obj) => warns.push(obj) };
    await adapter.sendReply('agent-1:sess-1', 'late');
    assert.ok(warns.length > 0, 'should warn about missing task');

    await adapter.stopStream();
  });

  it('serial dispatch: task B waits until task A dequeues', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    adapter.ws.send = () => {};
    const dispatched = [];
    adapter.onMsg = async (msg) => dispatched.push(msg.taskId);

    adapter.handleInbound(mkInbound('task-A', 'sess-1', 'msg1'), 'primary');
    adapter.handleInbound(mkInbound('task-B', 'sess-1', 'msg2'), 'primary');
    assert.deepEqual(dispatched, ['task-A'], 'task-B must NOT dispatch while A is active');

    // Complete task A via signal
    await adapter.onDeliveryBatchDone('agent-1:sess-1', true);
    assert.deepEqual(dispatched, ['task-A', 'task-B'], 'task-B dispatched after A completes');

    await adapter.stopStream();
  });

  it('multi-cat: append accumulation with separator', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    adapter.onMsg = async () => {};

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'hello'), 'primary');

    await adapter.sendReply('agent-1:sess-1', 'Cat A response');
    await adapter.sendReply('agent-1:sess-1', 'Cat B response');

    const artifacts = sent.map((f) => parseDetail(f)).filter((d) => d.result?.kind === 'artifact-update');

    assert.equal(artifacts.length, 2);
    assert.notEqual(artifacts[0].result.artifact.artifactId, artifacts[1].result.artifact.artifactId);

    // Cat A: append=false, plain text
    assert.equal(artifacts[0].result.append, false, 'first cat: append=false');
    assert.equal(artifacts[0].result.artifact.parts[0].text, 'Cat A response');

    // Cat B: append=true, with separator
    assert.equal(artifacts[1].result.append, true, 'second cat: append=true');
    assert.equal(artifacts[1].result.artifact.parts[0].text, '\n\n---\n\nCat B response');

    // Both have final=false
    assert.equal(artifacts[0].result.final, false);
    assert.equal(artifacts[1].result.final, false);

    // Close frame
    sent.length = 0;
    await adapter.onDeliveryBatchDone('agent-1:sess-1', true);
    const closeDetail = parseDetail(sent[0]);
    assert.equal(closeDetail.result.kind, 'status-update');
    assert.equal(closeDetail.result.final, true);

    await adapter.stopStream();
  });

  it('editMessage and deleteMessage are no-ops (non-streaming model)', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const adapter = new XiaoyiAdapter(mkLog(), mkOpts());
    const sent = captureSent(adapter);
    adapter.onMsg = async () => {};

    adapter.handleInbound(mkInbound('task-1', 'sess-1', 'go'), 'primary');
    await adapter.sendPlaceholder('agent-1:sess-1', '...');
    sent.length = 0;

    await adapter.editMessage('agent-1:sess-1', 'any-id', 'partial text');
    assert.equal(sent.length, 0, 'editMessage is no-op');

    await adapter.deleteMessage('any-id');
    assert.equal(sent.length, 0, 'deleteMessage is no-op');

    await adapter.stopStream();
  });

  it('HAG JSON-RPC error is logged', async () => {
    const { XiaoyiAdapter } = await import('../dist/infrastructure/connectors/adapters/XiaoyiAdapter.js');
    const warnings = [];
    const log = { ...mkLog(), warn: (...args) => warnings.push(args) };
    const adapter = new XiaoyiAdapter(log, mkOpts());
    adapter.ws.send = () => {};

    adapter.handleInbound(JSON.stringify({ error: { code: -32600, message: 'Invalid Request' } }), 'primary');
    assert.ok(warnings.length > 0, 'should log JSON-RPC error');
  });
});
