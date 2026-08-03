/**
 * K-1 / F288 — `safeParseExtra` MUST preserve `extra.pluginMessage`.
 *
 * Bug class twin of F194 Z9 (turnInvocationId): safeParseExtra is a
 * field-whitelist parser; pluginMessage was written by serializeExtra but
 * dropped on every Redis read → in Redis mode appendElements fails with
 * PERMISSION ('non-plugin message') and envelopes misproject plugin content
 * as host-relayed user messages. Caught by K-1 fresh-context cross-file scan.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const PLUGIN_MESSAGE = {
  instanceId: 'inst-a',
  revision: 2,
  provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
  elements: [
    { elementId: 'el-1', kind: 'text', payload: { text: 'hello' } },
    { elementId: 'el-2', kind: 'text', payload: { text: 'appended' }, epistemicStatus: 'inference' },
  ],
  appendOps: [{ operationId: 'op-1', elementIds: ['el-2'] }],
};

describe('F288 — safeParseExtra preserves pluginMessage (Redis read path)', () => {
  it('independent-field parser preserves empty arrays without Lua re-encoding', async () => {
    const { safeParsePluginMessage } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    assert.deepEqual(
      safeParsePluginMessage(
        JSON.stringify({ ...PLUGIN_MESSAGE, revision: 1, elements: [PLUGIN_MESSAGE.elements[0]], appendOps: [] }),
      ),
      {
        ...PLUGIN_MESSAGE,
        revision: 1,
        elements: [PLUGIN_MESSAGE.elements[0]],
        appendOps: [],
      },
    );
  });

  it('round-trip: serializeExtra → safeParseExtra keeps the full pluginMessage payload', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(serializeExtra({ pluginMessage: PLUGIN_MESSAGE }));
    assert.ok(parsed, 'extra with only pluginMessage must survive the round-trip');
    assert.deepEqual(parsed.pluginMessage, PLUGIN_MESSAGE);
  });

  it('pluginMessage coexists with other whitelisted keys', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({ isExplicitPost: true, pluginMessage: PLUGIN_MESSAGE, targetCats: ['opus'] }),
    );
    assert.equal(parsed.isExplicitPost, true);
    assert.deepEqual(parsed.targetCats, ['opus']);
    assert.deepEqual(parsed.pluginMessage, PLUGIN_MESSAGE);
  });

  it('fail-closed: malformed pluginMessage shapes are dropped, not passed through', async () => {
    const { safeParseExtra } = await import('../dist/domains/cats/services/stores/redis/redis-message-parsers.js');
    const malformed = [
      { pluginMessage: { instanceId: 42, revision: 1, provenance: {}, elements: [], appendOps: [] } },
      { pluginMessage: { instanceId: 'x', revision: 'nope', provenance: {}, elements: [], appendOps: [] } },
      { pluginMessage: { instanceId: 'x', revision: 1, provenance: {}, elements: 'nope', appendOps: [] } },
      { pluginMessage: { instanceId: 'x', revision: 1, provenance: {}, elements: [], appendOps: 'nope' } },
      { pluginMessage: { instanceId: 'x', revision: 1, elements: [], appendOps: [] } },
      {
        pluginMessage: {
          instanceId: 'x',
          revision: 1,
          provenance: {},
          elements: [],
          appendOps: [{ operationId: 42, elementIds: [] }],
        },
      },
      {
        pluginMessage: {
          instanceId: 'x',
          revision: 1,
          provenance: {},
          elements: [],
          appendOps: [{ operationId: 'op', elementIds: [42] }],
        },
      },
      { pluginMessage: { ...PLUGIN_MESSAGE, provenance: {} } },
      {
        pluginMessage: {
          ...PLUGIN_MESSAGE,
          appendOps: [{ operationId: 'op-1', elementIds: ['el-1'] }],
        },
      },
      {
        pluginMessage: {
          ...PLUGIN_MESSAGE,
          elements: [{ elementId: 42, kind: 'text', payload: { text: 'x' } }],
        },
      },
    ];
    for (const extra of malformed) {
      const parsed = safeParseExtra(JSON.stringify(extra));
      assert.equal(parsed?.pluginMessage, undefined, `malformed shape must be dropped: ${JSON.stringify(extra)}`);
    }
  });
});
