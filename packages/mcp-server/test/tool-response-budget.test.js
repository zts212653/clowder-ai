import assert from 'node:assert/strict';
import { test } from 'node:test';

test('F324: final guard counts all text blocks and appended hints for pure readers', async () => {
  const { protectToolResponse } = await import('../dist/tool-response-budget.js');
  const result = {
    content: [
      { type: 'text', text: 'x'.repeat(23_900) },
      { type: 'text', text: 'hint-'.repeat(500) },
    ],
  };
  const guarded = protectToolResponse('cat_cafe_search_evidence', result, true);
  assert.equal(guarded.isError, true);
  assert.ok(guarded.content[0].text.length < 1_000);
  assert.match(guarded.content[0].text, /source reader.*budget/i);

  const structured = {
    content: [{ type: 'text', text: 'short' }],
    structuredContent: { appendix: 'z'.repeat(30_000) },
  };
  assert.equal(protectToolResponse('cat_cafe_search_evidence', structured, true).isError, true);
  assert.equal(protectToolResponse('cat_cafe_list_events', structured, true).isError, true);
});

test('F324: final guard preserves successful writes and exact exposure evidence', async () => {
  const { protectToolResponse } = await import('../dist/tool-response-budget.js');
  const success = { content: [{ type: 'text', text: 'write succeeded '.repeat(2_000) }] };
  const exposure = { content: [{ type: 'text', text: 'full queued body '.repeat(2_000) }] };
  assert.equal(protectToolResponse('cat_cafe_post_message', success, false), success);
  assert.equal(protectToolResponse('cat_cafe_get_thread_context', exposure, true), exposure);
});

test('F324: final guard keeps multimodal blocks and skips a notice that cannot fit', async () => {
  const { protectToolResponse, appendFreshnessNoticeWithinBudget, canRequestFreshnessNotice } = await import(
    '../dist/tool-response-budget.js'
  );
  const image = { content: [{ type: 'image', data: 'a'.repeat(50_000), mimeType: 'image/png' }] };
  assert.equal(protectToolResponse('cat_cafe_list_events', image, true), image);
  const initial = { content: [{ type: 'text', text: 'x'.repeat(23_990) }] };
  const appended = appendFreshnessNoticeWithinBudget(initial, 'new unread message');
  assert.equal(appended.appended, false);
  assert.equal(appended.result, initial);
  assert.equal(
    canRequestFreshnessNotice(initial),
    false,
    'do not call an API that records notice delivery when the result has no reserved room',
  );
});
