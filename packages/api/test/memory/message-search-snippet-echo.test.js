import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectMessageSearchHighlights,
  projectMessageSearchSnippet,
} from '../../dist/domains/memory/message-search-snippet.js';

function originalSlice(body, query) {
  const snippet = projectMessageSearchSnippet(body, 'body', query);
  assert.equal(snippet.text, body.slice(snippet.start, snippet.end));
  assert.ok(snippet.text.length <= 240);
  for (const span of projectMessageSearchHighlights(snippet.text, query)) {
    assert.equal(
      snippet.text.slice(span.start, span.end),
      body.slice(snippet.start + span.start, snippet.start + span.end),
    );
  }
  return snippet;
}

test('a standalone tool report cannot displace a matching source body with its repeated query', () => {
  const body = [
    'Mira 是这只新猫给自己选的名字，原来的故事还会继续写。',
    '愿望和来历。'.repeat(70),
    '[爪感差: search_evidence 查询 Mira 起名时，搜索结果仍落在复验记录。]',
  ].join('\n\n');
  const snippet = originalSlice(body, 'Mira 起名');
  assert.ok(snippet.text.includes('给自己选的名字'));
  assert.ok(!snippet.text.includes('查询 Mira 起名'));
});

test('a query explicitly about the report retains its exact report evidence', () => {
  const body = `Mira 是新猫的名字。${'原来的故事。'.repeat(70)}\n\n[爪感差: search_evidence 查询 Mira 起名时丢失原文。]`;
  const snippet = originalSlice(body, '爪感差 Mira 起名');
  assert.ok(snippet.text.includes('查询 Mira 起名'));
});

test('a query naming the reported tool retains its diagnostic evidence', () => {
  const body = `Mira 是新猫的名字。${'原来的故事。'.repeat(70)}\n\n[爪感差: search_evidence 查询 Mira 起名时丢失原文。]`;
  const snippet = originalSlice(body, 'search_evidence Mira 起名');
  assert.ok(snippet.text.includes('查询 Mira 起名'));
});

test('explicit tool identifiers tolerate Markdown and punctuation without matching other identifiers', () => {
  const body = `Mira 是新猫的名字。${'原来的故事。'.repeat(70)}\n\n[爪感差: search_evidence 查询 Mira 起名时丢失原文。]`;
  for (const name of [
    '`search_evidence`',
    'search_evidence：',
    'search_evidence:',
    '**search_evidence**',
    '(search_evidence)',
    'SEARCH_EVIDENCE',
  ]) {
    assert.ok(originalSlice(body, `${name} Mira 起名`).text.includes('查询 Mira 起名'), name);
    assert.ok(originalSlice(body, name).text.includes('查询 Mira 起名'), `identifier-only: ${name}`);
  }
  for (const name of [
    'other_search_evidence',
    'search_evidence_extra',
    'search_evidence.v2',
    'search_evidence:cache',
  ]) {
    assert.ok(originalSlice(body, `${name} Mira 起名`).text.includes('Mira 是新猫的名字'), name);
  }
});

test('a report remains searchable when it is the only literal source', () => {
  const body = `${'普通背景。'.repeat(90)}\n\n[爪感差: sqlite vector 查询返回 SQLITE_BUSY。]`;
  const snippet = originalSlice(body, 'SQLITE_BUSY');
  assert.ok(snippet.text.includes('SQLITE_BUSY'));
});

test('inline and fenced marker examples stay ordinary original content', () => {
  for (const quote of [
    '文档里的格式示例是 [爪感差: search_evidence Mira 起名]，逐字引用供讲解。',
    '```text\n[爪感差: search_evidence Mira 起名]\n```',
  ]) {
    const body = `Mira 是新猫。${'背景叙述。'.repeat(90)}\n\n${quote}`;
    const snippet = originalSlice(body, 'Mira 起名');
    assert.ok(snippet.text.includes('search_evidence Mira 起名'));
  }
});

test('attachment text does not turn a quoted report into a publisher annotation', () => {
  const body = `Mira 是当前发布者的批注。${'附件中的背景。'.repeat(70)}\n\n[爪感差: search_evidence Mira 起名]`;
  const snippet = projectMessageSearchSnippet(body, 'attachment-text', 'Mira 起名');
  assert.equal(snippet.text, body.slice(snippet.start, snippet.end));
  assert.ok(snippet.text.includes('search_evidence Mira 起名'));
});

test('multiple standalone reports preserve CRLF and original UTF-16 source offsets', () => {
  const body = [
    '[爪感差：reader+旧缓存失效 [WARN]]',
    `${'😀'.repeat(130)}Mira 是这只新猫给自己选的名字。`,
    '已有故事。'.repeat(75),
    '[爪感差: search_evidence 查询 Mira 起名时丢失原文。]',
  ].join('\r\n\r\n');
  const snippet = originalSlice(body, 'Mira 起名');
  assert.ok(snippet.text.includes('给自己选的名字'));
  assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(snippet.text));
});
