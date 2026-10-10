// Early merge regression: run the actual pure TypeScript helper before the
// conflicted workspace can be installed/built. Node's strip-types loader erases
// its type-only shared imports. This does NOT validate HTTP/MCP consumers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as helper from '../packages/api/src/routes/callback-anchor-helpers.ts';

const item = {
  id: 'sandbox-quote',
  userId: 'integration-test',
  catId: null,
  content: '',
  timestamp: 1,
  contentBlocks: [
    {
      type: 'context_attachment',
      attachment: {
        kind: 'quote',
        text: 'quoted-source-'.repeat(80),
        comment: 'retain-user-intent',
      },
    },
  ],
};

test('structured quote text includes the paired comment before a long source', () => {
  assert.equal(typeof helper.callbackMessageText, 'function');
  const text = helper.callbackMessageText(item);
  assert.ok(text.startsWith('[评论]\nretain-user-intent\n\n[引用]\n'));
  assert.ok(text.endsWith(item.contentBlocks[0].attachment.text));
});

test('real anchor preview exposes intent, declares truncation and retains a full drill pointer', () => {
  const anchor = helper.anchorThreadMessage(item, {
    effectiveThreadId: 'sandbox-thread',
    speaker: 'co-creator',
  });
  assert.ok(anchor.preview.includes('retain-user-intent'));
  assert.equal(anchor.truncated, true);
  assert.equal(anchor.contentLength, helper.callbackMessageText(item).length);
  assert.equal(anchor.drillDown.args.messageId, item.id);
  assert.equal(anchor.drillDown.args.mode, 'full');
});
