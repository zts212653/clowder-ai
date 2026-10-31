import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalProjectDocumentWindow } from '../../dist/domains/memory/cue/sources/canonical-project-document.js';

test('bounded windows locate text after the first page and reconstruct the exact UTF-16 source', () => {
  const content = '前言🐾\n'.repeat(1_500) + '## Deployment procedure\n' + '核对版本。\n'.repeat(1_500);
  const located = canonicalProjectDocumentWindow(content, { query: 'DEPLOYMENT procedure' });
  assert.equal(located.location.status, 'matched');
  assert.match(located.content, /Deployment procedure/);
  assert.ok(located.contentRange.start > 4_000);
  let offset = 0;
  let reconstructed = '';
  do {
    const page = canonicalProjectDocumentWindow(content, { offset });
    assert.equal(page.content, content.slice(page.contentRange.start, page.contentRange.end));
    assert.ok(page.content.length <= 4_000);
    assert.equal(page.contentRange.total, content.length);
    assert.equal(page.contentRange.unit, 'utf16_code_unit');
    reconstructed += page.content;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, content);
});

test('legacy reads start at zero; missing query and end-of-file are honest and bounded', () => {
  const content = 'a'.repeat(4_001);
  const first = canonicalProjectDocumentWindow(content);
  assert.equal(first.content.length, 4_000);
  assert.equal(first.contentTruncated, true);
  assert.equal(first.nextOffset, 4_000);
  const missing = canonicalProjectDocumentWindow(content, { query: 'not present' });
  assert.equal(missing.location.status, 'not_found');
  assert.equal(missing.contentRange.start, 0);
  const end = canonicalProjectDocumentWindow(content, { offset: content.length + 50 });
  assert.equal(end.content, '');
  assert.equal(end.contentRange.start, content.length);
  assert.equal(end.nextOffset, null);
  assert.equal(canonicalProjectDocumentWindow('').contentTruncated, false);
});

test('lookup is literal and preserves source offsets when case folding can change string length', () => {
  const content = `${'İ'.repeat(4_500)} literal [x].(y)\n`;
  const located = canonicalProjectDocumentWindow(content, { query: '[x].(y)' });
  assert.equal(located.location.matchOffset, content.indexOf('[x].(y)'));
  assert.match(located.content, /literal \[x\]\.\(y\)/);
  assert.equal(canonicalProjectDocumentWindow(content, { query: '.*' }).location.status, 'not_found');
});
