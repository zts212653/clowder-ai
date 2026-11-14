import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectMessageSearchHighlights,
  projectMessageSearchSnippet,
} from '../../dist/domains/memory/message-search-projection.js';

function originalSlice(body, snippet) {
  assert.equal(snippet.text, body.slice(snippet.start, snippet.end));
  assert.ok(snippet.text.length <= 240);
  assert.ok(snippet.start >= 0 && snippet.end <= body.length);
}

test('raw multiword snippets retain the body after an introductory paragraph', () => {
  const body = '@gemini-argon\n\n用 npm 重新试一下登录，确认来源后继续。';
  const snippet = projectMessageSearchSnippet(body, 'body', 'npm 登录');
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes('用 npm 重新试一下登录'));
  assert.deepEqual(
    projectMessageSearchHighlights(snippet.text, 'npm 登录').map((r) => snippet.text.slice(r.start, r.end)),
    ['npm', '登录'],
  );
});

test('semantic-only snippets retain body text without inventing literal highlights', () => {
  const body = '@reviewer\n\n今天给这只新猫挑了一个称呼，记录原来的讨论。';
  const snippet = projectMessageSearchSnippet(body, 'body', 'Mira 起名');
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes('给这只新猫挑了一个称呼'));
  assert.deepEqual(projectMessageSearchHighlights(snippet.text, 'Mira 起名'), []);
});

test('multiple introductory paragraphs cannot consume the prose sentence budget', () => {
  const body = '@reviewer\n\n原始讨论\n\n给这只新猫挑了一个称呼，记录当时的决定。';
  const snippet = projectMessageSearchSnippet(body, 'body', 'Mira 起名');
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes('给这只新猫挑了一个称呼'));
  assert.deepEqual(projectMessageSearchHighlights(snippet.text, 'Mira 起名'), []);
});

test('blank LF/CRLF separators do not consume another substantive sentence', () => {
  for (const separator of ['\n\n', '\r\n\r\n', '\n \n\n']) {
    const body = `Introduction.${separator}The useful historical body follows. Third sentence.`;
    const snippet = projectMessageSearchSnippet(body, 'body', 'unmatched query');
    originalSlice(body, snippet);
    assert.ok(snippet.text.includes('The useful historical body follows.'));
    assert.ok(!snippet.text.includes('Third sentence.'));
  }
});

test('a later compact multiword window wins over an isolated opening word', () => {
  const body = `npm was mentioned before. ${'无关背景。'.repeat(90)}用 npm 重新试一下登录，确认来源后继续。`;
  const snippet = projectMessageSearchSnippet(body, 'body', 'npm 登录');
  originalSlice(body, snippet);
  assert.ok(snippet.start > 200);
  assert.ok(snippet.text.includes('用 npm 重新试一下登录'));
});

test('a full phrase remains the anchor even when other query words repeat nearby', () => {
  const body = `npm and 登录 are separate here. ${'原始背景。'.repeat(70)}真正的 npm 登录 原文在这里。`;
  const snippet = projectMessageSearchSnippet(body, 'body', 'npm 登录');
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes('真正的 npm 登录 原文'));
});

test('multiword highlights escape regex punctuation and identify every real occurrence', () => {
  const body = '用 C++ 重新试一下登录，再用 C++ 核对。';
  const ranges = projectMessageSearchHighlights(body, 'C++ 登录');
  assert.deepEqual(
    ranges.map((r) => body.slice(r.start, r.end)),
    ['C++', '登录', 'C++'],
  );
  assert.ok(ranges.every((r, i) => !i || ranges[i - 1].end <= r.start));
});

test('repeated short literal hits retain the existing 200-range wire limit', () => {
  const body = 'a'.repeat(240);
  const ranges = projectMessageSearchHighlights(body, 'a');
  assert.equal(ranges.length, 200);
  assert.ok(ranges.every((range) => body.slice(range.start, range.end) === 'a'));
});

test('window and highlight offsets remain original UTF-16 coordinates', () => {
  const body = `İ${'😀'.repeat(130)}原话：用 npm 重新试一下登录，后面还有 🦊。`;
  const snippet = projectMessageSearchSnippet(body, 'body', 'npm 登录');
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes('用 npm 重新试一下登录'));
  assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(snippet.text));
  for (const range of projectMessageSearchHighlights(snippet.text, 'npm 登录')) {
    assert.equal(
      body.slice(snippet.start + range.start, snippet.start + range.end),
      snippet.text.slice(range.start, range.end),
    );
  }
});

test('an exact source phrase remains anchored to its original sentence rather than other query terms', () => {
  const quote = 'The old pack was swapped after the incident.';
  const body = `@reviewer\n\n${'battery replacement was discussed. '.repeat(25)}${quote}\n来源仍保留。`;
  const snippet = projectMessageSearchSnippet(body, 'body', quote);
  originalSlice(body, snippet);
  assert.equal(snippet.source, 'body');
  assert.ok(snippet.text.includes(quote));
});

test('canonical-only attachment text preserves its source and offsets', () => {
  const canonical = `附件开头\n\n${'无关文本。'.repeat(70)}Only the attachment contains this exact evidence.`;
  const snippet = projectMessageSearchSnippet(
    canonical,
    'attachment-text',
    'Only the attachment contains this exact evidence.',
  );
  originalSlice(canonical, snippet);
  assert.equal(snippet.source, 'attachment-text');
  assert.ok(snippet.text.includes('Only the attachment contains this exact evidence.'));
});

test('an exact source phrase prefers its exact original spelling over an earlier case variant', () => {
  const quote = 'The old pack was swapped after the incident.';
  const body = `Counterexample: ${quote.toUpperCase()} ${'无关背景。'.repeat(80)}Actual outcome: ${quote}`;
  const snippet = projectMessageSearchSnippet(body, 'body', quote);
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes(quote));
  assert.ok(snippet.start > 200);
});

test('empty bodies and empty queries retain truthful bounded fallback slices', () => {
  assert.deepEqual(projectMessageSearchSnippet('', 'attachment-text', 'npm 登录'), {
    text: '',
    start: 0,
    end: 0,
    source: 'attachment-text',
  });
  const body = '\n\n原文仍在。';
  const snippet = projectMessageSearchSnippet(body, 'body');
  originalSlice(body, snippet);
  assert.ok(snippet.text.includes('原文仍在。'));
  assert.deepEqual(projectMessageSearchHighlights(body, '  '), []);
});
