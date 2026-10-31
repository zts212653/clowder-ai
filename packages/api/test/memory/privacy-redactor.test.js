// F186 Phase A Task 8: PrivacyRedactor — metadata-only redaction for private collections
// Covers AC-A9 (private collection hits → metadata-only in ALL persistence layers)

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

function item(anchor, title, summary) {
  return { anchor, kind: 'feature', status: 'active', title, summary, updatedAt: '2026-05-03' };
}

describe('PrivacyRedactor', () => {
  let redactForTranscript;

  before(async () => {
    ({ redactForTranscript } = await import('../../dist/domains/memory/privacy-redactor.js'));
  });

  it('public items pass through unchanged', () => {
    const items = [item('F001', 'Feature One', 'A summary')];
    const result = redactForTranscript(items, 'public');
    assert.equal(result[0].title, 'Feature One');
    assert.equal(result[0].summary, 'A summary');
  });

  it('internal items pass through unchanged', () => {
    const items = [item('F001', 'Feature One', 'A summary')];
    const result = redactForTranscript(items, 'internal');
    assert.equal(result[0].title, 'Feature One');
  });

  it('private items are redacted to metadata-only', () => {
    const items = [item('F001', 'Secret Feature', 'Secret summary')];
    const result = redactForTranscript(items, 'private');
    assert.equal(result[0].anchor, 'F001');
    assert.equal(result[0].kind, 'feature');
    assert.ok(result[0].title.includes('redacted'), 'title should be redacted');
    assert.equal(result[0].summary, undefined, 'summary should be stripped');
    assert.equal(result[0].passages, undefined, 'passages should be stripped');
  });

  it('restricted items are redacted', () => {
    const items = [item('F001', 'Top Secret', 'classified')];
    const result = redactForTranscript(items, 'restricted');
    assert.ok(result[0].title.includes('redacted'));
    assert.equal(result[0].summary, undefined);
  });

  it('preserves array length after redaction', () => {
    const items = [item('A', 'a', 's'), item('B', 'b', 's'), item('C', 'c', 's')];
    const result = redactForTranscript(items, 'private');
    assert.equal(result.length, 3);
  });
});
