import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { LiveNativeWork } from '../src/domains/concierge/live/live-native-work.js';

const item = (method: string, turnId: string, fields: Record<string, unknown>) => ({
  method,
  params: { threadId: 'native', turnId, item: fields },
});

test('Host work snapshot keeps exact task IDs across polls and classifies only native tool sources', () => {
  let now = 1000;
  const work = new LiveNativeWork('call', () => now);
  assert.deepEqual(work.snapshot().active, []);
  assert.doesNotMatch(
    JSON.stringify(work.snapshot()),
    /"call"/,
    'private renderer state must not reveal the Host call ID',
  );
  work.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'turn' } } });
  work.observe(
    item('item/started', 'turn', {
      id: 'fetch',
      type: 'mcpToolCall',
      server: 'cat-cafe-collab',
      tool: 'cat_cafe_get_thread_context',
    }),
  );
  const first = work.snapshot();
  const scopeId = createHash('sha256').update('call').digest('hex').slice(0, 16);
  assert.equal(first.active[0]?.taskId, `${scopeId}/turn/fetch`);
  assert.equal(first.active[0]?.kind, 'workspace_fetch');
  assert.deepEqual(work.snapshot(), first);
  work.observe(
    item('item/started', 'turn', {
      id: 'fetch',
      type: 'mcpToolCall',
      server: 'cat-cafe-collab',
      tool: 'cat_cafe_get_thread_context',
    }),
  );
  assert.equal(work.snapshot().revision, first.revision);
  work.observe(
    item('item/completed', 'turn', {
      id: 'fetch',
      type: 'mcpToolCall',
      status: 'completed',
      result: { isError: false },
    }),
  );
  assert.equal(work.snapshot().active.length, 0);
  assert.equal(work.snapshot().recent.at(-1)?.phase, 'completed');

  work.observe(
    item('item/started', 'turn', {
      id: 'graph',
      type: 'mcpToolCall',
      server: 'cat-cafe-collab',
      tool: 'cat_cafe_graph_resolve',
    }),
  );
  assert.equal(work.snapshot().active[0]?.kind, 'workspace_fetch');
  work.observe(item('item/completed', 'turn', { id: 'graph', type: 'mcpToolCall', status: 'completed' }));

  work.observe(
    item('item/started', 'turn', {
      id: 'memory-read',
      type: 'mcpToolCall',
      server: 'cat-cafe-memory',
      tool: 'cat_cafe_read_session_digest',
    }),
  );
  assert.equal(work.snapshot().active[0]?.kind, 'workspace_fetch');
  work.observe(item('item/completed', 'turn', { id: 'memory-read', type: 'mcpToolCall' }));

  work.observe(
    item('item/started', 'turn', {
      id: 'proposal',
      type: 'mcpToolCall',
      server: 'cat-cafe-memory',
      tool: 'cat_cafe_propose_person_memory',
    }),
  );
  assert.equal(work.snapshot().active[0]?.kind, 'tool', 'a memory write is not a workspace fetch');
  work.observe(item('item/completed', 'turn', { id: 'proposal', type: 'mcpToolCall', status: 'completed' }));

  work.observe(
    item('item/started', 'turn', {
      id: 'send',
      type: 'mcpToolCall',
      server: 'cat-cafe-collab',
      tool: 'cat_cafe_cross_post_message',
    }),
  );
  assert.equal(work.snapshot().active[0]?.kind, 'workspace_dispatch');
  work.observe(item('item/completed', 'turn', { id: 'send', type: 'mcpToolCall', status: 'failed' }));
  assert.equal(work.snapshot().recent.at(-1)?.phase, 'failed', 'a rejected dispatch must never animate as delivered');

  work.observe(
    item('item/started', 'turn', {
      id: 'read',
      type: 'mcpToolCall',
      server: 'cat-cafe-selected-screen',
      tool: 'view_shared_screen',
    }),
  );
  assert.equal(work.snapshot().active[0]?.kind, 'screen_read');
  work.observe(item('item/completed', 'turn', { id: 'read', type: 'mcpToolCall' }));
  work.observe(
    item('item/started', 'turn', {
      id: 'other-screen-tool',
      type: 'mcpToolCall',
      server: 'cat-cafe-selected-screen',
      tool: 'unknown_tool',
    }),
  );
  assert.equal(work.snapshot().active[0]?.kind, 'tool', 'unknown screen tools cannot claim a screen read');
  work.observe({
    method: 'turn/completed',
    params: { threadId: 'native', turn: { id: 'turn', status: 'interrupted' } },
  });
  assert.equal(work.snapshot().recent.at(-1)?.phase, 'cancelled');
  assert.equal(work.snapshot().active.length, 0);

  work.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'next' } } });
  work.observe(item('item/started', 'next', { id: 'long', type: 'mcpToolCall' }));
  now += 300_001;
  assert.equal(work.snapshot().active.length, 0);
  assert.equal(work.snapshot().recent.at(-1)?.phase, 'expired');
  now += 120_001;
  assert.deepEqual(work.snapshot().recent, []);
});

test('a completed envelope without status closes reasoning and MCP work unless it carries an error', () => {
  const work = new LiveNativeWork('call', () => 1000);
  work.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'turn' } } });
  for (const [id, type] of [
    ['reason', 'reasoning'],
    ['mcp', 'mcpToolCall'],
  ]) {
    work.observe(item('item/started', 'turn', { id, type }));
    work.observe(item('item/completed', 'turn', { id, type }));
    assert.equal(work.snapshot().recent.at(-1)?.phase, 'completed', `${type} completion defaults to success`);
  }
  work.observe(item('item/started', 'turn', { id: 'failed', type: 'mcpToolCall' }));
  work.observe(item('item/completed', 'turn', { id: 'failed', type: 'mcpToolCall', result: { isError: true } }));
  assert.equal(work.snapshot().recent.at(-1)?.phase, 'failed');
});

test('duplicate and terminal turn starts cannot rewind the current work scope', () => {
  const work = new LiveNativeWork('call', () => 1000);
  const lifecycle = (method: string, id: string) =>
    work.observe({ method, params: { threadId: 'native', turn: { id } } });
  lifecycle('turn/started', 'old');
  work.observe(item('item/started', 'old', { id: 'first', type: 'mcpToolCall' }));
  const first = work.snapshot();
  lifecycle('turn/started', 'old');
  assert.deepEqual(work.snapshot(), first, 'same-turn start replay does not cancel its active work');
  lifecycle('turn/completed', 'old');
  lifecycle('turn/started', 'new');
  work.observe(item('item/started', 'new', { id: 'current', type: 'mcpToolCall' }));
  const current = work.snapshot();
  lifecycle('turn/started', 'old');
  assert.equal(
    work.observe(item('item/started', 'old', { id: 'ghost', type: 'mcpToolCall' })),
    false,
    'a stale item must not reach other call observers',
  );
  assert.deepEqual(work.snapshot(), current, 'a terminal old turn cannot displace current work');
});

test('late prior-turn events and events after call close cannot restore false work', () => {
  const work = new LiveNativeWork('call', () => 1000);
  work.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'old' } } });
  work.observe(item('item/started', 'old', { id: 'tool', type: 'mcpToolCall' }));
  work.observe({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'old', status: 'completed' } } });
  const afterOld = work.snapshot().revision;
  work.observe(item('item/started', 'old', { id: 'late', type: 'mcpToolCall' }));
  assert.equal(work.snapshot().revision, afterOld);
  work.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'new' } } });
  work.observe(item('item/started', 'old', { id: 'later', type: 'mcpToolCall' }));
  assert.equal(work.snapshot().active.length, 0);
  work.observe(item('item/started', 'new', { id: 'current', type: 'mcpToolCall' }));
  assert.equal(work.snapshot().active.length, 1);
  (work as unknown as { close: () => void }).close();
  const closed = work.snapshot();
  work.observe({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'newer' } } });
  work.observe(item('item/started', 'newer', { id: 'ghost', type: 'mcpToolCall' }));
  assert.equal(work.snapshot().active.length, 0);
  assert.deepEqual(work.snapshot(), closed);
});

test('same-call native result handoff has one stable event and explicit source', () => {
  const work = new LiveNativeWork('call', () => 1000);
  work.resultHandedToVoice('turn', 'answer', 'codex');
  const first = work.snapshot();
  work.resultHandedToVoice('turn', 'answer', 'codex');
  assert.deepEqual(work.snapshot(), first, 'native replay cannot create a second carry event');
  assert.deepEqual(first.recent[0], {
    eventId: `${createHash('sha256').update('call').digest('hex').slice(0, 16)}:1`,
    taskId: `${createHash('sha256').update('call').digest('hex').slice(0, 16)}/turn`,
    kind: 'result',
    phase: 'result_handed_to_voice',
    resultId: `${createHash('sha256').update('call').digest('hex').slice(0, 16)}/turn/answer`,
    nativeCarrierCatId: 'codex',
    occurredAt: 1000,
    expiresAt: 121000,
  });
});
