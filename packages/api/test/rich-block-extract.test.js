import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractRichFromText,
  isValidRichBlock,
  normalizeRichBlock,
} from '../dist/domains/cats/services/agents/routing/rich-block-extract.js';

describe('extractRichFromText', () => {
  it('returns original text when no cc_rich blocks', () => {
    const result = extractRichFromText('Hello world');
    assert.equal(result.cleanText, 'Hello world');
    assert.deepEqual(result.blocks, []);
  });

  it('extracts valid cc_rich block and returns clean text', () => {
    const input = `Here is the result:
\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"card","v":1,"title":"Summary","tone":"info"}]}
\`\`\`
Done.`;
    const result = extractRichFromText(input);
    assert.equal(result.cleanText, 'Here is the result:\n\nDone.');
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].id, 'b1');
    assert.equal(result.blocks[0].kind, 'card');
  });

  it('extracts multiple cc_rich blocks', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"card","v":1,"title":"A"}]}
\`\`\`
middle text
\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b2","kind":"diff","v":1,"filePath":"a.ts","diff":"+foo"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 2);
    assert.equal(result.blocks[0].kind, 'card');
    assert.equal(result.blocks[1].kind, 'diff');
    assert.ok(result.cleanText.includes('middle text'));
    assert.ok(!result.cleanText.includes('cc_rich'));
  });

  it('ignores invalid JSON in cc_rich blocks', () => {
    const input = `\`\`\`cc_rich
{not valid json}
\`\`\`
after`;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
    // Invalid block is silently removed
    assert.equal(result.cleanText, '\nafter');
  });

  it('ignores cc_rich block with wrong version', () => {
    const input = `\`\`\`cc_rich
{"v":2,"blocks":[{"id":"b1","kind":"card"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  it('skips blocks missing id or kind', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"kind":"card"},{"id":"b2"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  it('skips card without title', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"card","v":1}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  it('skips checklist with non-array items', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"checklist","v":1,"items":"not-array"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  it('skips checklist with malformed item (missing text)', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"checklist","v":1,"items":[{"id":"i1"}]}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  it('skips media_gallery with malformed item (missing url)', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"media_gallery","v":1,"items":[{"alt":"no url"}]}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  it('accepts valid checklist block', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"checklist","v":1,"items":[{"id":"i1","text":"Task 1"}]}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, 'checklist');
  });
});

describe('isValidRichBlock', () => {
  it('rejects null/undefined/primitives', () => {
    assert.equal(isValidRichBlock(null), false);
    assert.equal(isValidRichBlock(undefined), false);
    assert.equal(isValidRichBlock('string'), false);
    assert.equal(isValidRichBlock(42), false);
  });

  it('rejects missing id or v', () => {
    assert.equal(isValidRichBlock({ kind: 'card', v: 1, title: 'X' }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', title: 'X' }), false);
  });

  it('rejects unknown kind', () => {
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'unknown', v: 1 }), false);
  });

  it('validates card requires title', () => {
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', v: 1 }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', v: 1, title: 'OK' }), true);
  });

  it('rejects card with malformed optional fields', () => {
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', v: 1, title: 'OK', fields: 'oops' }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', v: 1, title: 'OK', fields: [{ label: 'a' }] }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', v: 1, title: 'OK', bodyMarkdown: 123 }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'card', v: 1, title: 'OK', tone: 'invalid' }), false);
  });

  it('accepts card with valid optional fields', () => {
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'card',
        v: 1,
        title: 'OK',
        bodyMarkdown: 'text',
        tone: 'warning',
        fields: [{ label: 'a', value: 'b' }],
      }),
      true,
    );
  });

  it('validates diff requires filePath + diff', () => {
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'diff', v: 1, filePath: 'a.ts' }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'diff', v: 1, diff: '+x' }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'diff', v: 1, filePath: 'a.ts', diff: '+x' }), true);
  });

  it('rejects diff with malformed languageHint', () => {
    assert.equal(
      isValidRichBlock({ id: 'b1', kind: 'diff', v: 1, filePath: 'a.ts', diff: '+x', languageHint: 42 }),
      false,
    );
  });

  it('validates checklist items shape', () => {
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'checklist', v: 1, items: 'bad' }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'checklist', v: 1, items: [{ id: 'i1' }] }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'checklist', v: 1, items: [{ id: 'i1', text: 'OK' }] }), true);
  });

  it('validates media_gallery items shape', () => {
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'media_gallery', v: 1, items: [{ alt: 'no url' }] }), false);
    assert.equal(isValidRichBlock({ id: 'b1', kind: 'media_gallery', v: 1, items: [{ url: 'http://x' }] }), true);
  });

  it('rejects media_gallery item with non-URL string in url (e.g. text description)', () => {
    // Gemini bug: putting text descriptions instead of actual URLs
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: '砚砚戴着齿轮勋章的威严侧脸' }],
      }),
      false,
    );
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: 'A cute cat with blue eyes sitting in a box' }],
      }),
      false,
    );
  });

  it('accepts media_gallery with valid URL formats', () => {
    // Local path
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: '/avatars/opus.png' }],
      }),
      true,
    );
    // HTTP URL
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: 'https://example.com/img.png' }],
      }),
      true,
    );
    // Data URI
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: 'data:image/png;base64,abc123' }],
      }),
      true,
    );
  });

  it('rejects media_gallery item with non-string alt/caption', () => {
    assert.equal(
      isValidRichBlock({ id: 'b1', kind: 'media_gallery', v: 1, items: [{ url: 'http://x', alt: 42 }] }),
      false,
    );
    assert.equal(
      isValidRichBlock({ id: 'b1', kind: 'media_gallery', v: 1, items: [{ url: 'http://x', caption: { bad: true } }] }),
      false,
    );
    assert.equal(
      isValidRichBlock({
        id: 'b1',
        kind: 'media_gallery',
        v: 1,
        items: [{ url: 'http://x', alt: 'ok', caption: 'ok' }],
      }),
      true,
    );
  });

  it('rejects checklist item with non-boolean checked', () => {
    assert.equal(
      isValidRichBlock({ id: 'b1', kind: 'checklist', v: 1, items: [{ id: 'i1', text: 'OK', checked: 'yes' }] }),
      false,
    );
    assert.equal(
      isValidRichBlock({ id: 'b1', kind: 'checklist', v: 1, items: [{ id: 'i1', text: 'OK', checked: true }] }),
      true,
    );
  });

  it('validates audio blocks (F34)', () => {
    // Valid minimal audio block
    assert.equal(isValidRichBlock({ id: 'a1', kind: 'audio', v: 1, url: '/api/tts/audio/abc123.wav' }), true);
    // Valid audio block with all optional fields
    assert.equal(
      isValidRichBlock({
        id: 'a2',
        kind: 'audio',
        v: 1,
        url: '/api/tts/audio/abc123.wav',
        title: 'Speech',
        durationSec: 3.5,
        mimeType: 'audio/wav',
      }),
      true,
    );
    // Missing url
    assert.equal(isValidRichBlock({ id: 'a3', kind: 'audio', v: 1 }), false);
    // Invalid optional field types
    assert.equal(isValidRichBlock({ id: 'a4', kind: 'audio', v: 1, url: '/x', title: 42 }), false);
    assert.equal(isValidRichBlock({ id: 'a5', kind: 'audio', v: 1, url: '/x', durationSec: 'bad' }), false);
    assert.equal(isValidRichBlock({ id: 'a6', kind: 'audio', v: 1, url: '/x', mimeType: 123 }), false);
  });

  // F34-b: voice messages have `text` but no `url` — backend synthesizes url
  it('F34-b: audio block with text but no url is valid (pending synthesis)', () => {
    assert.equal(isValidRichBlock({ id: 'a7', kind: 'audio', v: 1, text: 'Spoken content' }), true);
  });

  it('F34-b: audio block with neither text nor url is invalid', () => {
    assert.equal(isValidRichBlock({ id: 'a8', kind: 'audio', v: 1 }), false);
  });

  it('F34-b: audio block with whitespace-only text is invalid (R11 regression)', () => {
    assert.equal(isValidRichBlock({ id: 'a10', kind: 'audio', v: 1, text: '   ' }), false);
    assert.equal(isValidRichBlock({ id: 'a11', kind: 'audio', v: 1, text: '\t\n' }), false);
  });

  it('F34-b: audio block with whitespace-only url is invalid (R11 regression)', () => {
    assert.equal(isValidRichBlock({ id: 'a12', kind: 'audio', v: 1, url: '   ' }), false);
  });

  it('F34-b: audio block with both text and url is valid', () => {
    assert.equal(isValidRichBlock({ id: 'a9', kind: 'audio', v: 1, url: '/api/tts/audio/x.wav', text: 'Hello' }), true);
  });
});

// #85 T1-T4: normalizeRichBlock
describe('normalizeRichBlock', () => {
  it('T1: maps type → kind for valid kinds', () => {
    const obj = { id: 'b1', type: 'card', v: 1, title: 'Hi' };
    const result = normalizeRichBlock(obj);
    assert.equal(result.kind, 'card');
    assert.equal(result.type, undefined);
  });

  it('T2: auto-fills v: 1 when missing', () => {
    const obj = { id: 'b1', kind: 'card', title: 'Hi' };
    const result = normalizeRichBlock(obj);
    assert.equal(result.v, 1);
  });

  it('T3: does not convert non-rich objects', () => {
    // Object with type that is NOT a valid kind
    const obj = { id: 'x', type: 'button', label: 'Click' };
    const result = normalizeRichBlock(obj);
    assert.equal(result.type, 'button');
    assert.equal(result.kind, undefined);
  });

  it('T3b: passes through primitives unchanged', () => {
    assert.equal(normalizeRichBlock(null), null);
    assert.equal(normalizeRichBlock('hello'), 'hello');
    assert.equal(normalizeRichBlock(42), 42);
  });

  it('T4: does not overwrite existing kind', () => {
    const obj = { id: 'b1', kind: 'diff', type: 'card', v: 1, filePath: 'a.ts', diff: '+x' };
    const result = normalizeRichBlock(obj);
    assert.equal(result.kind, 'diff');
    // type is preserved when kind already exists
    assert.equal(result.type, 'card');
  });

  it('combines type→kind + auto v for full normalization', () => {
    const obj = { id: 'b1', type: 'checklist', items: [{ id: 'i1', text: 'Task' }] };
    const result = normalizeRichBlock(obj);
    assert.equal(result.kind, 'checklist');
    assert.equal(result.v, 1);
    assert.equal(result.type, undefined);
  });
});

// #85 T5-T6: bare JSON array strong-match extraction
describe('extractRichFromText bare JSON tolerance', () => {
  it('T5: extracts bare JSON array with valid rich blocks', () => {
    const input = JSON.stringify([{ id: 'b1', type: 'card', title: 'Summary', bodyMarkdown: '**bold**' }]);
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, 'card');
    assert.equal(result.blocks[0].v, 1);
    assert.equal(result.cleanText, '');
  });

  it('T6a: does not extract bare JSON when elements lack id+kind/type', () => {
    const input = JSON.stringify([{ name: 'foo', value: 42 }]);
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
    assert.equal(result.cleanText, input);
  });

  it('T6b: does not extract bare JSON embedded in normal text', () => {
    const input = `Here is some JSON: [{"id":"b1","type":"card","title":"X"}] and more text`;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
    assert.ok(result.cleanText.includes('Here is some JSON'));
  });

  it('T6c: mixed array (some valid, some not) keeps original text (cloud P1)', () => {
    // Array where first element is a valid card, second has unknown type "event"
    const input = JSON.stringify([
      { id: 'b1', type: 'card', title: 'ok' },
      { id: 'x', type: 'event', payload: 1 },
    ]);
    const result = extractRichFromText(input);
    // Must NOT extract partial blocks — keep original text intact
    assert.equal(result.blocks.length, 0);
    assert.equal(result.cleanText, input);
  });

  it('T5b: bare JSON with normalize applies type→kind and auto v', () => {
    const input = JSON.stringify([
      { id: 'b1', type: 'diff', filePath: 'a.ts', diff: '+x' },
      { id: 'b2', type: 'card', title: 'Test' },
    ]);
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 2);
    assert.equal(result.blocks[0].kind, 'diff');
    assert.equal(result.blocks[1].kind, 'card');
    // Both should have v: 1 auto-filled
    assert.equal(result.blocks[0].v, 1);
    assert.equal(result.blocks[1].v, 1);
  });
});

// F34-b: audio blocks with `text` but no `url` in cc_rich fenced blocks
describe('extractRichFromText F34-b audio voice messages', () => {
  it('extracts text-only audio block from cc_rich fenced block', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"a1","kind":"audio","v":1,"text":"Hello, I am the cat"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    const block = result.blocks[0];
    assert.equal(block.kind, 'audio');
    assert.equal(block.id, 'a1');
    assert.equal(block.text, 'Hello, I am the cat');
    assert.equal(block.url, undefined, 'no url present — pending synthesis');
  });

  it('rejects audio block with neither text nor url inside cc_rich', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"a2","kind":"audio","v":1}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0, 'block with no text or url must be rejected');
  });

  it('rejects audio block with whitespace-only text in cc_rich (R11 regression)', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"a4","kind":"audio","v":1,"text":"   "}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0, 'whitespace-only text must be rejected');
  });

  it('extracts audio block that has both text and url', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"a3","kind":"audio","v":1,"url":"/api/tts/audio/x.wav","text":"Transcript"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, 'audio');
    assert.equal(result.blocks[0].url, '/api/tts/audio/x.wav');
    assert.equal(result.blocks[0].text, 'Transcript');
  });

  // F120 Phase C: html_widget extraction
  it('extracts html_widget block from cc_rich', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"hw1","kind":"html_widget","v":1,"html":"<h1>Hello</h1>","title":"Demo"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, 'html_widget');
    assert.equal(result.blocks[0].html, '<h1>Hello</h1>');
    assert.equal(result.blocks[0].title, 'Demo');
  });

  it('rejects html_widget with empty html', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"hw2","kind":"html_widget","v":1,"html":""}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0); // rejected by isValidRichBlock
  });

  it('rejects html_widget with non-string height', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"hw3","kind":"html_widget","v":1,"html":"<p>X</p>","height":"tall"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 0);
  });

  // F088 Phase J: file block
  it('extracts file block from cc_rich', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"f1","kind":"file","v":1,"url":"/uploads/report.pdf","fileName":"调研报告.pdf"}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, 'file');
    assert.equal(result.blocks[0].url, '/uploads/report.pdf');
    assert.equal(result.blocks[0].fileName, '调研报告.pdf');
  });

  it('extracts file block with optional mimeType and fileSize', () => {
    const input = `\`\`\`cc_rich
{"v":1,"blocks":[{"id":"f2","kind":"file","v":1,"url":"/uploads/doc.docx","fileName":"doc.docx","mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","fileSize":12345}]}
\`\`\``;
    const result = extractRichFromText(input);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(result.blocks[0].fileSize, 12345);
  });

  it('validates file block: rejects missing url', () => {
    assert.equal(isValidRichBlock({ id: 'f1', kind: 'file', v: 1, fileName: 'x.pdf' }), false);
  });

  it('validates file block: rejects missing fileName', () => {
    assert.equal(isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/uploads/x.pdf' }), false);
  });

  it('validates file block: rejects empty url', () => {
    assert.equal(isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '  ', fileName: 'x.pdf' }), false);
  });

  it('validates file block: rejects empty fileName', () => {
    assert.equal(isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/uploads/x.pdf', fileName: '' }), false);
  });

  it('validates file block: rejects non-string mimeType', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/x', fileName: 'x.pdf', mimeType: 123 }),
      false,
    );
  });

  it('validates file block: rejects non-number fileSize', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/x', fileName: 'x.pdf', fileSize: 'big' }),
      false,
    );
  });

  it('validates file block: accepts valid file block', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }),
      true,
    );
  });

  // P0 security: reject arbitrary local paths (prevents file exfiltration via Telegram)
  it('validates file block: rejects absolute path outside whitelist', () => {
    assert.equal(isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/etc/passwd', fileName: 'passwd' }), false);
  });

  it('validates file block: rejects path traversal', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/uploads/../../etc/passwd', fileName: 'passwd' }),
      false,
    );
  });

  // P1 security: reject javascript: URLs (prevents XSS via frontend <a href>)
  it('validates file block: rejects javascript: URL', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: 'javascript:alert(1)', fileName: 'xss.pdf' }),
      false,
    );
  });

  it('validates file block: rejects data:text/html URL', () => {
    assert.equal(
      isValidRichBlock({
        id: 'f1',
        kind: 'file',
        v: 1,
        url: 'data:text/html,<script>alert(1)</script>',
        fileName: 'xss',
      }),
      false,
    );
  });

  // Whitelist: accepts safe URL patterns
  it('validates file block: accepts /api/ prefixed URLs', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: '/api/connector-media/file.pdf', fileName: 'file.pdf' }),
      true,
    );
  });

  it('validates file block: accepts https:// URLs', () => {
    assert.equal(
      isValidRichBlock({ id: 'f1', kind: 'file', v: 1, url: 'https://example.com/doc.pdf', fileName: 'doc.pdf' }),
      true,
    );
  });
});
