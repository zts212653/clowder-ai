import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiAcpEvents } from '../dist/domains/cats/services/agents/providers/pi/pi-acp-events.js';

// Reuses #14's empty-delta guard, and extends it to final snapshots and Host output semantics.
test('Pi empty/whitespace deltas cannot suppress final content', () => {
  for (const delta of ['', '   ']) {
    const output = [];
    const events = new PiAcpEvents((value) => output.push(value));
    events.accept({ type: 'message_start', message: { role: 'assistant' } });
    events.accept({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
    events.accept({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], stopReason: 'stop' },
    });
    assert.equal(
      output
        .filter((v) => v.sessionUpdate === 'agent_message_chunk')
        .map((v) => v.content.text)
        .join('')
        .trim(),
      'final answer',
    );
  }
});

test('Pi reconciles a partial stream with the final snapshot without duplication', () => {
  const output = [];
  const events = new PiAcpEvents((value) => output.push(value));
  events.accept({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'final ' } });
  events.accept({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], stopReason: 'stop' },
  });
  assert.equal(output.map((v) => v.content?.text ?? '').join(''), 'final answer');
});
