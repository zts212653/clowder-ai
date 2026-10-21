import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeSave } from './analyze-member-save.mjs';

test('separates concurrent/background spans, deduplicates client delivery, and retains unresolved evidence', () => {
  const event = { event: 'member_save', traceId: 'save', pid: 1, source: 'server', revision: 'build' };
  const browser = { ...event, source: 'browser', seq: 0, phase: 'save', state: 'finish', durationMs: 11000 };
  const result = summarizeSave(
    [
      { ...event, requestId: 'a', spanId: 1, phase: 'http.request', state: 'start' },
      { ...event, requestId: 'a', spanId: 1, phase: 'http.request', state: 'finish', durationMs: 10000 },
      { ...event, requestId: 'b', spanId: 1, phase: 'http.request', state: 'start' },
      { ...event, requestId: 'a', spanId: 2, phase: 'pool.codex.close', state: 'start' },
      { ...event, requestId: 'a', spanId: 2, phase: 'pool.codex.close', state: 'finish', durationMs: 9000 },
      { ...event, requestId: 'a', spanId: 3, phase: 'l0.warm', state: 'start', background: true },
      browser,
      browser,
    ],
    'save',
  );
  assert.equal(result.save.durationMs, 11000);
  assert.equal(result.foreground.length, 3);
  assert.equal(result.foreground.find((s) => s.requestId === 'b').state, 'incomplete');
  assert.equal(result.background[0].state, 'incomplete');
  assert.equal(result.browserEvents.length, 1);
  assert.match(summarizeSave([], 'empty').browserEvidence, /missing/);
});
