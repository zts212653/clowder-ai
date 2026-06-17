import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { digestRichBlocks } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { safeParseExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';

describe('digestRichBlocks', () => {
  it('returns content unchanged when no extra.rich', () => {
    const msg = { content: 'hello', extra: undefined };
    assert.equal(digestRichBlocks(msg), 'hello');
  });

  it('appends card digest', () => {
    const msg = {
      content: 'here is the result',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'b1', kind: 'card', v: 1, title: 'Review Summary', tone: 'info' }],
        },
      },
    };
    const result = digestRichBlocks(msg);
    assert.ok(result.includes('here is the result'));
    assert.ok(result.includes('[卡片: Review Summary]'));
  });

  it('appends diff digest with filePath', () => {
    const msg = {
      content: 'changes',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'b1', kind: 'diff', v: 1, filePath: 'src/app.ts', diff: '+foo' }],
        },
      },
    };
    const result = digestRichBlocks(msg);
    assert.ok(result.includes('[代码 diff: src/app.ts]'));
  });

  it('appends checklist digest', () => {
    const msg = {
      content: 'todo list',
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'b1',
              kind: 'checklist',
              v: 1,
              items: [
                { id: 'i1', text: 'a' },
                { id: 'i2', text: 'b' },
              ],
            },
          ],
        },
      },
    };
    const result = digestRichBlocks(msg);
    assert.ok(result.includes('[清单: 2 项]'));
  });

  it('appends media_gallery digest', () => {
    const msg = {
      content: 'images',
      extra: {
        rich: {
          v: 1,
          blocks: [
            { id: 'b1', kind: 'media_gallery', v: 1, items: [{ url: 'a.png' }, { url: 'b.png' }, { url: 'c.png' }] },
          ],
        },
      },
    };
    const result = digestRichBlocks(msg);
    assert.ok(result.includes('[图片: 3 张]'));
  });
  // P1-1: malformed blocks must not crash digest
  it('does not crash on checklist without items', () => {
    const msg = {
      content: 'text',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'b1', kind: 'checklist', v: 1 /* no items */ }],
        },
      },
    };
    assert.doesNotThrow(() => digestRichBlocks(msg));
  });

  it('does not crash on media_gallery without items', () => {
    const msg = {
      content: 'text',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'b1', kind: 'media_gallery', v: 1 /* no items */ }],
        },
      },
    };
    assert.doesNotThrow(() => digestRichBlocks(msg));
  });

  it('does not crash on card without title', () => {
    const msg = {
      content: 'text',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'b1', kind: 'card', v: 1 /* no title */ }],
        },
      },
    };
    assert.doesNotThrow(() => digestRichBlocks(msg));
  });

  it('does not crash on diff without filePath', () => {
    const msg = {
      content: 'text',
      extra: {
        rich: {
          v: 1,
          blocks: [{ id: 'b1', kind: 'diff', v: 1 /* no filePath */ }],
        },
      },
    };
    assert.doesNotThrow(() => digestRichBlocks(msg));
  });
});

describe('safeParseExtra', () => {
  it('returns undefined for empty/null', () => {
    assert.equal(safeParseExtra(undefined), undefined);
    assert.equal(safeParseExtra(''), undefined);
  });

  it('parses valid rich extra', () => {
    const raw = JSON.stringify({ rich: { v: 1, blocks: [{ id: 'b1', kind: 'card' }] } });
    const result = safeParseExtra(raw);
    assert.ok(result);
    assert.ok(result.rich);
    assert.equal(result.rich.v, 1);
    assert.equal(result.rich.blocks.length, 1);
  });

  it('returns undefined for invalid JSON', () => {
    assert.equal(safeParseExtra('{broken'), undefined);
  });

  it('returns undefined for wrong rich version', () => {
    const raw = JSON.stringify({ rich: { v: 2, blocks: [] } });
    assert.equal(safeParseExtra(raw), undefined);
  });

  it('returns undefined for rich without blocks array', () => {
    const raw = JSON.stringify({ rich: { v: 1, blocks: 'not-array' } });
    assert.equal(safeParseExtra(raw), undefined);
  });

  // #80: stream.invocationId support
  it('parses stream-only extra', () => {
    const raw = JSON.stringify({ stream: { invocationId: 'inv-1' } });
    const result = safeParseExtra(raw);
    assert.ok(result, 'stream-only should not return undefined');
    assert.equal(result.stream?.invocationId, 'inv-1');
    assert.equal(result.rich, undefined);
  });

  it('parses rich + stream together', () => {
    const raw = JSON.stringify({
      rich: { v: 1, blocks: [{ id: 'b1', kind: 'card' }] },
      stream: { invocationId: 'inv-2' },
    });
    const result = safeParseExtra(raw);
    assert.ok(result);
    assert.ok(result.rich, 'rich should be preserved');
    assert.equal(result.rich.blocks.length, 1);
    assert.equal(result.stream?.invocationId, 'inv-2');
  });

  it('ignores stream with invalid shape (no invocationId)', () => {
    const raw = JSON.stringify({ stream: { foo: 'bar' } });
    assert.equal(safeParseExtra(raw), undefined);
  });

  it('ignores stream with non-string invocationId', () => {
    const raw = JSON.stringify({ stream: { invocationId: 123 } });
    assert.equal(safeParseExtra(raw), undefined);
  });

  // Fix: context_briefing systemKind must survive Redis round-trip for API filtering
  it('preserves systemKind context_briefing through round-trip', () => {
    const raw = JSON.stringify({ systemKind: 'context_briefing' });
    const result = safeParseExtra(raw);
    assert.ok(result, 'context_briefing extra should not return undefined');
    assert.equal(result.systemKind, 'context_briefing');
  });

  it('preserves systemKind a2a_routing through round-trip (existing behavior)', () => {
    const raw = JSON.stringify({ systemKind: 'a2a_routing' });
    const result = safeParseExtra(raw);
    assert.ok(result, 'a2a_routing extra should not return undefined');
    assert.equal(result.systemKind, 'a2a_routing');
  });

  it('ignores unknown systemKind values', () => {
    const raw = JSON.stringify({ systemKind: 'unknown_kind' });
    assert.equal(safeParseExtra(raw), undefined);
  });
});
