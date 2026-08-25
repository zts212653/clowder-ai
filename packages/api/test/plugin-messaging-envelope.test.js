/**
 * K-1 / F288 — envelope pure projection (plan Task 4, D-1)
 * MessageEnvelope is a projection of StoredMessage — no second truth source.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/envelope.js')} */
let envelope;

before(async () => {
  envelope = await import('../dist/domains/messaging/envelope.js');
});

function pluginStoredMessage(overrides = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'hello world',
    mentions: [],
    timestamp: 1_800_000_000_000,
    extra: {
      pluginMessage: {
        instanceId: 'inst-a',
        revision: 2,
        provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
        elements: [
          { elementId: 'el-1', kind: 'text', payload: { text: 'hello world' } },
          {
            elementId: 'el-2',
            kind: 'text',
            payload: { text: 'appended' },
            epistemicStatus: 'inference',
            derivedFromElementId: 'el-1',
          },
        ],
        appendOps: [{ operationId: 'op-1', elementIds: ['el-2'] }],
      },
    },
    ...overrides,
  };
}

describe('projectEnvelope — plugin messages (D-1)', () => {
  test('projects canonical envelope from stored plugin message', () => {
    const env = envelope.projectEnvelope(pluginStoredMessage());
    assert.ok(env);
    assert.equal(env.messageId, 'msg-1');
    assert.equal(env.threadId, 'thread-1');
    assert.equal(env.revision, 2);
    assert.deepEqual(env.actor, { kind: 'plugin', id: 'inst-a' });
    assert.deepEqual(env.audience, { kind: 'public' });
    assert.equal(env.payload.elements.length, 2);
    assert.equal(env.payload.provenance.epistemicStatus, 'inference');
    assert.equal(env.occurredAt, new Date(1_800_000_000_000).toISOString());
  });

  test('whisper visibility projects whisper audience with targets', () => {
    const env = envelope.projectEnvelope(pluginStoredMessage({ visibility: 'whisper', whisperTo: ['cat-a', 'cat-b'] }));
    assert.deepEqual(env.audience, { kind: 'whisper', targets: ['cat-a', 'cat-b'] });
  });

  test('replyTo passes through', () => {
    const env = envelope.projectEnvelope(pluginStoredMessage({ replyTo: 'msg-0' }));
    assert.equal(env.replyTo, 'msg-0');
  });
});

describe('projectEnvelope — host-relayed messages (snapshot support)', () => {
  test('user message → actor user, epistemic user_intent, deterministic text element', () => {
    const env = envelope.projectEnvelope({
      id: 'msg-u',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'user says hi',
      mentions: [],
      timestamp: 1_800_000_000_001,
    });
    assert.deepEqual(env.actor, { kind: 'user', id: 'user-1' });
    assert.equal(env.revision, 1);
    assert.equal(env.payload.provenance.epistemicStatus, 'user_intent');
    assert.deepEqual(env.payload.provenance.origin, { kind: 'host' });
    assert.deepEqual(env.payload.elements, [
      { elementId: 'el_msg-u_0', kind: 'text', payload: { text: 'user says hi' } },
    ]);
  });

  test('cat message → actor cat, epistemic inference', () => {
    const env = envelope.projectEnvelope({
      id: 'msg-c',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: 'cat replies',
      mentions: [],
      timestamp: 1_800_000_000_002,
    });
    assert.deepEqual(env.actor, { kind: 'cat', id: 'opus' });
    assert.equal(env.payload.provenance.epistemicStatus, 'inference');
  });

  test('deleted / tombstoned messages project to null', () => {
    assert.equal(envelope.projectEnvelope(pluginStoredMessage({ deletedAt: 1 })), null);
    assert.equal(envelope.projectEnvelope(pluginStoredMessage({ _tombstone: true, deletedAt: 1 })), null);
  });

  test('malformed pluginMessage extra degrades to null (fail-closed projection)', () => {
    const env = envelope.projectEnvelope(
      pluginStoredMessage({ extra: { pluginMessage: { instanceId: 42, revision: 'x', elements: 'nope' } } }),
    );
    assert.equal(env, null);
  });

  test('structurally malformed provenance, elements, and append records fail closed', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const malformed = [
      { ...base, provenance: {} },
      { ...base, elements: [{ elementId: 42, kind: 'text', payload: { text: 'x' } }] },
      { ...base, appendOps: [{ operationId: 'op-1', elementIds: [42] }] },
    ];
    for (const pluginMessage of malformed) {
      assert.equal(envelope.projectEnvelope(pluginStoredMessage({ extra: { pluginMessage } })), null);
    }
  });

  test('INV-19: canonical hydration rejects closed-schema, bound, and relationship violations', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    // beta.5 raised maxElementsPerMessage from 32 → 128
    const manyElements = Array.from({ length: 129 }, (_, index) => ({
      elementId: `el-${index}`,
      kind: 'text',
      payload: { text: String(index) },
    }));
    const malformed = [
      ['root unknown key', { ...base, unexpected: true }],
      ['provenance unknown key', { ...base, provenance: { ...base.provenance, unexpected: true } }],
      [
        'origin unknown key',
        { ...base, provenance: { ...base.provenance, origin: { ...base.provenance.origin, unexpected: true } } },
      ],
      [
        'source address unknown key',
        {
          ...base,
          provenance: {
            origin: {
              kind: 'external',
              connectorId: 'telegram',
              sourceAddress: { connectorId: 'telegram', chatId: 'chat-1', unexpected: true },
            },
            epistemicStatus: 'observation',
          },
        },
      ],
      ['element unknown key', { ...base, elements: [{ ...base.elements[0], unexpected: true }] }],
      [
        'text payload unknown key',
        { ...base, elements: [{ ...base.elements[0], payload: { text: 'x', unexpected: true } }] },
      ],
      ['append record unknown key', { ...base, appendOps: [{ ...base.appendOps[0], unexpected: true }] }],
      ['more than 128 elements', { ...base, revision: 1, elements: manyElements, appendOps: [] }],
      [
        'duplicate element ids',
        {
          ...base,
          revision: 1,
          elements: [base.elements[0], { ...base.elements[0], payload: { text: 'duplicate' } }],
          appendOps: [],
        },
      ],
      [
        'missing derivation source',
        { ...base, revision: 1, elements: [{ ...base.elements[0], derivedFromElementId: 'missing' }], appendOps: [] },
      ],
      ['revision does not match append history', { ...base, revision: 3 }],
      [
        'append record references unknown element',
        { ...base, appendOps: [{ operationId: 'op-1', elementIds: ['missing'] }] },
      ],
    ];

    for (const [name, pluginMessage] of malformed) {
      assert.equal(envelope.parsePluginMessageExtra(pluginMessage), null, name);
    }
  });

  test('INV-19: append history exactly reconstructs the canonical stamped element suffix', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const el3 = {
      elementId: 'el-3',
      kind: 'text',
      payload: { text: 'also appended' },
      epistemicStatus: 'inference',
    };
    const canonical = {
      ...base,
      revision: 3,
      elements: [...base.elements, el3],
      appendOps: [
        { operationId: 'op-1', elementIds: ['el-2'], baseRevision: 1 },
        { operationId: 'op-2', elementIds: ['el-3'], baseRevision: 2 },
      ],
    };
    assert.ok(envelope.parsePluginMessageExtra(canonical), 'writer-produced history remains valid');

    const twoElementAppend = {
      ...base,
      elements: [base.elements[0], base.elements[1], el3],
      appendOps: [{ operationId: 'op-1', elementIds: ['el-2', 'el-3'], baseRevision: 1 }],
    };
    const malformed = [
      [
        'initial element claimed while actual append is unclaimed',
        { ...base, appendOps: [{ operationId: 'op-1', elementIds: ['el-1'] }] },
      ],
      [
        'appended suffix order differs from operation history',
        { ...twoElementAppend, appendOps: [{ operationId: 'op-1', elementIds: ['el-3', 'el-2'] }] },
      ],
      [
        'appended suffix element is absent from operation history',
        { ...twoElementAppend, appendOps: [{ operationId: 'op-1', elementIds: ['el-2'] }] },
      ],
      [
        'present baseRevision is not the immediately preceding revision',
        {
          ...canonical,
          appendOps: [canonical.appendOps[0], { ...canonical.appendOps[1], baseRevision: 1 }],
        },
      ],
      [
        'appended element is missing the canonical epistemic stamp',
        {
          ...base,
          elements: [base.elements[0], { ...base.elements[1], epistemicStatus: undefined }],
        },
      ],
      [
        'append derives from another element in the same operation',
        {
          ...twoElementAppend,
          elements: [base.elements[0], base.elements[1], { ...el3, derivedFromElementId: 'el-2' }],
        },
      ],
    ];

    for (const [name, pluginMessage] of malformed) {
      assert.equal(envelope.parsePluginMessageExtra(pluginMessage), null, name);
    }
  });

  test('INV-20: media_ref and rich_block payload objects remain open', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const pluginMessage = {
      ...base,
      elements: [
        { elementId: 'el-media', kind: 'media_ref', payload: { uri: 'asset://one', custom: { width: 4 } } },
        {
          elementId: 'el-rich',
          kind: 'rich_block',
          payload: { kind: 'card', v: 1, custom: true },
          epistemicStatus: 'inference',
        },
      ],
      appendOps: [{ operationId: 'op-1', elementIds: ['el-rich'] }],
    };
    assert.ok(envelope.parsePluginMessageExtra(pluginMessage));
  });

  test('beta.11 JSON scalar tree rejects lone surrogates before historical projection', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const pluginMessage = {
      ...base,
      revision: 1,
      elements: [{ elementId: 'el-invalid-text', kind: 'text', payload: { text: '\ud800' } }],
      appendOps: [],
    };
    assert.equal(envelope.parsePluginMessageExtra(pluginMessage), null);
  });

  test('beta.11 JSON scalar tree rejects non-finite values inside open payloads', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    for (const kind of ['media_ref', 'rich_block']) {
      const pluginMessage = {
        ...base,
        revision: 1,
        elements: [{ elementId: `el-invalid-${kind}`, kind, payload: { nested: { value: Number.NaN } } }],
        appendOps: [],
      };
      assert.equal(envelope.parsePluginMessageExtra(pluginMessage), null, kind);
    }
  });
});
