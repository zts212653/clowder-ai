/**
 * F096: Interactive Rich Block — type normalization + validation tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRichBlock } from '@cat-cafe/shared';

describe('F096: normalizeRichBlock — interactive kind', () => {
  it('T1: type→kind alias works for interactive', () => {
    const raw = { type: 'interactive', id: 'i1', interactiveType: 'select', options: [] };
    const result = normalizeRichBlock(raw);
    assert.strictEqual(result.kind, 'interactive');
    assert.strictEqual(result.type, undefined);
  });

  it('T2: auto-fills v:1 for interactive', () => {
    const raw = { kind: 'interactive', id: 'i1', interactiveType: 'select', options: [] };
    const result = normalizeRichBlock(raw);
    assert.strictEqual(result.v, 1);
  });

  it('T3: leaves existing interactive block untouched', () => {
    const raw = {
      kind: 'interactive',
      v: 1,
      id: 'i1',
      interactiveType: 'card-grid',
      options: [{ id: 'o1', label: 'Cat A' }],
      allowRandom: true,
    };
    const result = normalizeRichBlock(raw);
    assert.strictEqual(result.kind, 'interactive');
    assert.strictEqual(result.v, 1);
    assert.strictEqual(result.allowRandom, true);
  });
});

import { isValidRichBlock } from '../dist/domains/cats/services/agents/routing/rich-block-extract.js';

describe('F096: isValidRichBlock — interactive', () => {
  it('T4: valid select block', () => {
    const block = {
      id: 'i1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      options: [{ id: 'o1', label: 'Option A' }],
    };
    assert.strictEqual(isValidRichBlock(block), true);
  });

  it('T5: valid confirm block', () => {
    const block = {
      id: 'i2',
      kind: 'interactive',
      v: 1,
      interactiveType: 'confirm',
      options: [
        { id: '__confirm__', label: '确认' },
        { id: '__cancel__', label: '取消' },
      ],
    };
    assert.strictEqual(isValidRichBlock(block), true);
  });

  it('T6: valid card-grid with allowRandom', () => {
    const block = {
      id: 'i3',
      kind: 'interactive',
      v: 1,
      interactiveType: 'card-grid',
      options: [{ id: 'c1', label: '宪宪', emoji: '🐱' }],
      allowRandom: true,
    };
    assert.strictEqual(isValidRichBlock(block), true);
  });

  it('T7: invalid — missing options', () => {
    const block = { id: 'i1', kind: 'interactive', v: 1, interactiveType: 'select' };
    assert.strictEqual(isValidRichBlock(block), false);
  });

  it('T8: invalid — empty options array', () => {
    const block = { id: 'i1', kind: 'interactive', v: 1, interactiveType: 'select', options: [] };
    assert.strictEqual(isValidRichBlock(block), false);
  });

  it('T9: invalid — unknown interactiveType', () => {
    const block = {
      id: 'i1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'slider',
      options: [{ id: 'o1', label: 'A' }],
    };
    assert.strictEqual(isValidRichBlock(block), false);
  });

  it('T10: valid block with disabled + selectedIds (persisted state)', () => {
    const block = {
      id: 'i1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      options: [{ id: 'o1', label: 'A' }],
      disabled: true,
      selectedIds: ['o1'],
    };
    assert.strictEqual(isValidRichBlock(block), true);
  });
});

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

describe('F096: MessageStore.updateExtra', () => {
  it('T11: updates extra.rich block state', () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'hello',
      mentions: [],
      timestamp: Date.now(),
      extra: {
        rich: {
          v: 1,
          blocks: [
            { id: 'i1', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'o1', label: 'A' }] },
          ],
        },
      },
    });

    const updated = store.updateExtra(msg.id, {
      rich: {
        v: 1,
        blocks: [
          {
            id: 'i1',
            kind: 'interactive',
            v: 1,
            interactiveType: 'select',
            options: [{ id: 'o1', label: 'A' }],
            disabled: true,
            selectedIds: ['o1'],
          },
        ],
      },
    });

    assert.ok(updated);
    assert.strictEqual(updated.extra.rich.blocks[0].disabled, true);
    assert.deepStrictEqual(updated.extra.rich.blocks[0].selectedIds, ['o1']);
  });

  it('T12: returns null for non-existent message', () => {
    const store = new MessageStore();
    const result = store.updateExtra('nonexistent', { rich: { v: 1, blocks: [] } });
    assert.strictEqual(result, null);
  });

  it('T13: preserves other extra fields (regression)', () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'hi',
      mentions: [],
      timestamp: Date.now(),
      extra: {
        rich: { v: 1, blocks: [] },
        stream: { invocationId: 'inv-1' },
      },
    });

    const updated = store.updateExtra(msg.id, {
      rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1, title: 'Test' }] },
    });

    assert.ok(updated);
    assert.strictEqual(updated.extra.stream.invocationId, 'inv-1');
    assert.strictEqual(updated.extra.rich.blocks.length, 1);
  });
});

// P1-2 fix: isValidRichBlock must reject options with invalid elements
describe('F096: isValidRichBlock — options element validation (P1-2)', () => {
  it('T16: rejects options containing null', () => {
    const block = {
      id: 'i1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      options: [null],
    };
    assert.strictEqual(isValidRichBlock(block), false);
  });

  it('T17: rejects options missing id field', () => {
    const block = {
      id: 'i1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      options: [{ label: 'A' }],
    };
    assert.strictEqual(isValidRichBlock(block), false);
  });

  it('T18: rejects options missing label field', () => {
    const block = {
      id: 'i1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      options: [{ id: 'o1' }],
    };
    assert.strictEqual(isValidRichBlock(block), false);
  });
});

// Route-level integration tests for PATCH /api/messages/:id/block-state
import Fastify from 'fastify';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';

describe('F096: PATCH /block-state route guards (P1-1, P2-2)', () => {
  async function createApp(store) {
    const app = Fastify();
    const mockSocket = { broadcastToThread: () => {}, broadcastToAll: () => {} };
    await app.register(messageActionsRoutes, { messageStore: store, socketManager: mockSocket });
    await app.ready();
    return app;
  }

  it('T19: returns 403 for wrong userId', async () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'owner',
      catId: 'opus',
      content: 'pick',
      mentions: [],
      timestamp: Date.now(),
      extra: {
        rich: {
          v: 1,
          blocks: [
            { id: 'i1', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'o1', label: 'A' }] },
          ],
        },
      },
    });
    const app = await createApp(store);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msg.id}/block-state`,
      payload: { userId: 'attacker', blockId: 'i1', disabled: true, selectedIds: ['o1'] },
    });
    assert.strictEqual(res.statusCode, 403);
  });

  it('T20: returns 400 for non-interactive block', async () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'owner',
      catId: 'opus',
      content: 'card msg',
      mentions: [],
      timestamp: Date.now(),
      extra: { rich: { v: 1, blocks: [{ id: 'c1', kind: 'card', v: 1, title: 'Card' }] } },
    });
    const app = await createApp(store);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msg.id}/block-state`,
      payload: { userId: 'owner', blockId: 'c1', disabled: true },
    });
    assert.strictEqual(res.statusCode, 400);
  });

  it('T21: returns 200 and calls updateExtra for valid owner + interactive block', async () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'owner',
      catId: 'opus',
      content: 'pick',
      mentions: [],
      timestamp: Date.now(),
      extra: {
        rich: {
          v: 1,
          blocks: [
            { id: 'i1', kind: 'interactive', v: 1, interactiveType: 'select', options: [{ id: 'o1', label: 'A' }] },
          ],
        },
      },
    });
    // Spy on updateExtra to verify persistence path is exercised
    let updateExtraCalled = false;
    const origUpdateExtra = store.updateExtra.bind(store);
    store.updateExtra = (id, extra) => {
      updateExtraCalled = true;
      return origUpdateExtra(id, extra);
    };
    const app = await createApp(store);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${msg.id}/block-state`,
      payload: { userId: 'owner', blockId: 'i1', disabled: true, selectedIds: ['o1'] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).status, 'ok');
    assert.strictEqual(updateExtraCalled, true, 'updateExtra must be called for persistence');
  });
});

import { extractRichFromText } from '../dist/domains/cats/services/agents/routing/rich-block-extract.js';

describe('F096: extractRichFromText — interactive', () => {
  it('T14: extracts interactive block from cc_rich fence', () => {
    const container = JSON.stringify({
      v: 1,
      blocks: [
        {
          id: 'i1',
          kind: 'interactive',
          v: 1,
          interactiveType: 'select',
          options: [
            { id: 'o1', label: '方案 A' },
            { id: 'o2', label: '方案 B' },
          ],
        },
      ],
    });
    const text = `请选择方案：\n\`\`\`cc_rich\n${container}\n\`\`\``;
    const { blocks, cleanText } = extractRichFromText(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'interactive');
    assert.ok(cleanText.includes('请选择方案'));
  });

  it('T15: extracts card-grid with allowRandom from cc_rich', () => {
    const container = JSON.stringify({
      v: 1,
      blocks: [
        {
          id: 'g1',
          kind: 'interactive',
          v: 1,
          interactiveType: 'card-grid',
          options: [{ id: 'c1', label: '宪宪', emoji: '🐱' }],
          allowRandom: true,
        },
      ],
    });
    const text = `选猫猫：\n\`\`\`cc_rich\n${container}\n\`\`\``;
    const { blocks } = extractRichFromText(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'interactive');
  });
});
