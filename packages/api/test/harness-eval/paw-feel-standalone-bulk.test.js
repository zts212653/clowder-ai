import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractPawFeelMarkers,
  extractStandalonePawFeelMarkers,
  isStandalonePawFeelMarker,
} from '../../dist/infrastructure/harness-eval/friction/paw-feel-marker.js';

test('bulk standalone extraction preserves the original marker grammar and source offsets', () => {
  const cases = [
    '',
    '[爪感差: rg+慢]',
    '头部\r\n \t[爪感差：rg 输出 [WARN] 过多] \r\n\r\n[爪感差: alpha:start: 失败]\r\n',
    '行内 [爪感差: rg+慢] 是示例\n\\[爪感差: rg+转义]\n[爪感差: 工具+现象]',
    '```text\n[爪感差: rg+示例]\n```\n[爪感差: rg+实际报告]',
    '  ~~~~text\r\n[爪感差: rg+示例]\r\n~~~\r\n[爪感差: rg+仍在围栏]\r\n~~~~\r\n[爪感差: rg+报告]',
    '[爪感差: rg+多行\n保留历史语法]\n[爪感差: rg+之后的报告]',
    '[爪感差: rg+一] [爪感差: rg+二]\n[爪感差: 中文现象没有工具]',
  ];
  for (const body of cases) {
    const expected = extractPawFeelMarkers(body).filter((marker) => isStandalonePawFeelMarker(body, marker));
    assert.deepEqual(extractStandalonePawFeelMarkers(body), expected);
  }
});

test('bulk extraction keeps every independent report in a long body', () => {
  const report = '[爪感差: rg+慢]';
  const line = `前文\r\n${report}\r\n`;
  const body = line.repeat(4000);
  const markers = extractStandalonePawFeelMarkers(body);
  assert.equal(markers.length, 4000);
  assert.ok(markers.every((m, i) => m.raw === report && m.sourceIndex === i * line.length + 4));
  assert.deepEqual(extractStandalonePawFeelMarkers(report.repeat(4000)), []);
  assert.deepEqual(extractStandalonePawFeelMarkers('plain text\n'.repeat(8000)), []);
});

// Independent reference for the historical regex grammar; production must not
// retry this expression on every malformed prefix in a long source body.
function legacySpans(text) {
  const spans = [];
  for (const match of text.matchAll(/\[爪感差[:：]\s*((?:[^[\]]|\[[^\]]*\])*?)\]/g)) {
    let slashes = 0;
    for (let i = match.index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    if (slashes % 2 || match[1].trim() === '工具+现象') continue;
    spans.push({ raw: match[0], sourceIndex: match.index });
  }
  return spans;
}

test('linear extraction preserves historical complete and malformed grammar on deterministic combinations', () => {
  const spans = (markers) => markers.map(({ raw, sourceIndex }) => ({ raw, sourceIndex }));
  const atoms = [
    '原话😀',
    ' ',
    '\t',
    '\n',
    '\r\n',
    '\\',
    '\\\\',
    '[',
    ']',
    '[爪感差:',
    '[爪感差： ',
    'rg+慢',
    '[WARN]',
    '[爪感差: rg+慢]',
    '[爪感差: 工具+现象]',
    '```text\n',
    '\n```\n',
    '~~~~\r\n',
    '~~~\r\n',
    'alpha:start: 失败',
  ];
  let seed = 0x3226764;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let sample = 0; sample < 12000; sample++) {
    let text = '';
    const count = next() % 30;
    for (let i = 0; i < count; i++) text += atoms[next() % atoms.length];
    const expected = legacySpans(text);
    assert.deepEqual(spans(extractPawFeelMarkers(text)), expected, `extract sample ${sample}: ${JSON.stringify(text)}`);
    assert.deepEqual(
      spans(extractStandalonePawFeelMarkers(text)),
      expected.filter((marker) => isStandalonePawFeelMarker(text, marker)),
      `standalone sample ${sample}: ${JSON.stringify(text)}`,
    );
  }
});
