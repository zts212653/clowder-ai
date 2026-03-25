import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatTelegramHtml } from '../dist/infrastructure/connectors/adapters/telegram-html-formatter.js';

describe('formatTelegramHtml', () => {
  it('formats card with title and body', () => {
    const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'All good' }];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(html.includes('<b>[布偶猫🐱]</b>'));
    assert.ok(html.includes('<b>Review</b>'));
    assert.ok(html.includes('All good'));
  });

  it('formats checklist with emoji checkboxes', () => {
    const blocks = [
      {
        id: 'b2',
        kind: 'checklist',
        v: 1,
        items: [
          { id: 'i1', text: 'Done', checked: true },
          { id: 'i2', text: 'Pending' },
        ],
      },
    ];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(html.includes('✅ Done'));
    assert.ok(html.includes('☐ Pending'));
  });

  it('formats diff as pre/code block', () => {
    const blocks = [{ id: 'b3', kind: 'diff', v: 1, filePath: 'src/a.ts', diff: '+line' }];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(html.includes('<pre>'));
    assert.ok(html.includes('+line'));
  });

  it('escapes HTML special chars in content', () => {
    const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Test <script>', bodyMarkdown: 'a & b' }];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&amp;'));
  });

  it('respects Telegram 4096 char limit with truncation', () => {
    const longBody = 'x'.repeat(5000);
    const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Big', bodyMarkdown: longBody }];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(html.length <= 4096);
  });

  it('formats audio block with text', () => {
    const blocks = [{ id: 'b4', kind: 'audio', v: 1, url: 'https://x.mp3', text: 'Hello' }];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(html.includes('🔊 Hello'));
  });

  it('formats media_gallery', () => {
    const blocks = [
      {
        id: 'b5',
        kind: 'media_gallery',
        v: 1,
        title: 'Screenshots',
        items: [{ url: 'https://img.png', caption: 'UI' }],
      },
    ];
    const html = formatTelegramHtml(blocks, '布偶猫');
    assert.ok(html.includes('Screenshots'));
    assert.ok(html.includes('UI'));
  });

  // P1-2: textContent must not be discarded
  it('includes textContent in output when provided', () => {
    const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'LGTM' }];
    const html = formatTelegramHtml(blocks, '布偶猫', 'Here is my summary');
    assert.ok(html.includes('Here is my summary'));
    assert.ok(html.includes('Review'));
  });

  it('omits textContent when empty string', () => {
    const blocks = [{ id: 'b1', kind: 'card', v: 1, title: 'Review', bodyMarkdown: 'LGTM' }];
    const html = formatTelegramHtml(blocks, '布偶猫', '');
    assert.ok(html.includes('Review'));
    // Should not have double blank lines from empty textContent
    assert.ok(!html.includes('\n\n\n'));
  });
});
