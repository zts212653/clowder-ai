import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/message-search-answer-fixture.js';

function selection(row, quote = row.content) {
  return {
    threadId: row.threadId,
    messageId: row.id,
    contentRevision: createHash('sha256').update(row.content).digest('hex'),
    quote,
    reason: 'This is the original source selected by the answering cat.',
  };
}

test('answer preparation consumes only the chosen source and sentence without another search', async () => {
  const f = fixture();
  try {
    const chosen = selection(f.source[1], 'original source 1');
    const result = await f.service.prepare({ ...f.request, selections: [chosen] });
    assert.equal(result.status, 'prepared');
    assert.deepEqual(
      result.response.results.map((row) => row.messageId),
      [f.source[1].id],
    );
    assert.equal(f.searches(), 0, 'selected answer preparation must not retrieve a second list');
    assert.equal(f.calls(), 0);
    assert.equal(result.response.meta.qualification, undefined, 'cat choice cannot become historical supported');
  } finally {
    f.db.close();
  }
});

test('a selected quotation absent from the exact current source is rejected instead of publishing other search hits', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.service.prepare({ ...f.request, selections: [selection(f.source[1], 'piano approved unconditionally')] }),
      /QUOTE|quote|selection/i,
    );
  } finally {
    f.db.close();
  }
});

test('a selected private whisper is not replaced by public hits from a fresh search', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.service.prepare({ ...f.request, selections: [selection(f.source[3])] }),
      /SOURCE|source|selection|accessible/i,
    );
  } finally {
    f.db.close();
  }
});
