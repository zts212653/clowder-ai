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
  test('accepts frozen typed media elements only when closed payloads and warning references are valid', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const media = { elementId: 'media-1', kind: 'media_ref', payload: { type: 'image', reference: 'hmr_123' } };
    const unavailable = {
      elementId: 'missing-1',
      kind: 'media_unavailable',
      payload: { type: 'video', fileName: 'clip.mp4', reason: 'unavailable' },
    };
    const warning = {
      elementId: 'warning-1',
      kind: 'media_warning',
      payload: { mediaElementId: 'media-1', stage: 'preview', reason: 'processing_failed' },
    };
    const valid = { ...base, revision: 1, elements: [media, unavailable, warning], appendOps: [] };
    assert.ok(envelope.parsePluginMessageExtra(valid));
    assert.equal(
      envelope.renderElementsText(valid.elements),
      '[media_ref:media-1]\n[media_unavailable:missing-1]\n[media_warning:warning-1]',
    );

    const invalidPayloads = [
      { ...unavailable, payload: { ...unavailable.payload, locator: 'secret' } },
      { ...unavailable, payload: { ...unavailable.payload, type: 'unknown' } },
      { ...warning, payload: { ...warning.payload, stage: 'unknown' } },
      { ...warning, payload: { ...warning.payload, mediaElementId: 'absent' } },
    ];
    for (const invalid of invalidPayloads) {
      const elements = invalid.kind === 'media_warning' ? [media, unavailable, invalid] : [media, invalid, warning];
      assert.equal(envelope.parsePluginMessageExtra({ ...valid, elements }), null, JSON.stringify(invalid));
    }
  });

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
  test('cat causal trigger becomes plugin replyTo without changing the Hub replyTo field', () => {
    const base = {
      id: 'cat-reply',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'cat-1',
      content: 'answer',
      mentions: [],
      timestamp: 1_800_000_000_000,
      extra: { causal: { kind: 'invocation_reply', triggerMessageId: 'trigger-1', triggerThreadId: 'thread-1' } },
    };
    assert.equal(base.replyTo, undefined);
    assert.equal(envelope.projectEnvelope(base).replyTo, 'trigger-1');
    assert.equal(envelope.projectEnvelope({ ...base, replyTo: 'explicit-a2a' }).replyTo, 'explicit-a2a');
    assert.equal(envelope.projectEnvelope({ ...base, catId: null }).replyTo, undefined);
    assert.equal(
      envelope.projectEnvelope({
        ...base,
        extra: { causal: { ...base.extra.causal, triggerThreadId: 'other-thread' } },
      }).replyTo,
      undefined,
    );
    assert.equal(envelope.projectEnvelope({ ...base, extra: {} }).replyTo, undefined);
  });

  test('invalid historical rich-block shapes use the shared invalid_shape degradation exit', () => {
    const blocks = [
      { id: '', kind: 'card', v: 1, title: 'Missing id' },
      { id: 'old-kind', kind: '', v: 1, title: 'Missing kind' },
      { id: 'old-version', kind: 'card', v: 0, title: 'Old version' },
    ];
    const warnings = [];
    const previousWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let env;
    try {
      env = envelope.projectEnvelope({
        id: 'msg-invalid-rich',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        content: 'cat replies',
        mentions: [],
        timestamp: 1_800_000_000_002,
        extra: { rich: { v: 1, blocks } },
      });
    } finally {
      console.warn = previousWarn;
    }
    assert.deepEqual(
      env.payload.elements.map((element) => element.kind),
      ['text', 'text', 'text', 'text'],
    );
    assert.deepEqual(
      warnings.map(([, detail]) => detail.reason),
      ['invalid_shape', 'invalid_shape', 'invalid_shape'],
    );
  });

  test('projects non-media stored rich blocks unchanged after text, omitting media for W2-5b', () => {
    const card = {
      id: 'card-1',
      kind: 'card',
      v: 1,
      title: 'Memory proposal',
      meta: { kind: 'person_memory_proposal', candidateId: 'candidate-1' },
    };
    const checklist = {
      id: 'list-1',
      kind: 'checklist',
      v: 1,
      title: 'Next steps',
      items: [{ id: 'step-1', text: 'Review', checked: false }],
    };
    const audio = { id: 'audio-1', kind: 'audio', v: 1, url: '/api/tts/audio/relative' };
    const env = envelope.projectEnvelope({
      id: 'msg-rich',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      content: 'cat replies',
      mentions: [],
      timestamp: 1_800_000_000_002,
      extra: { rich: { v: 1, blocks: [card, audio, checklist] } },
    });
    assert.deepEqual(env.payload.elements, [
      { elementId: 'el_msg-rich_0', kind: 'text', payload: { text: 'cat replies' } },
      { elementId: 'el_msg-rich_1', kind: 'rich_block', payload: card, epistemicStatus: 'inference' },
      { elementId: 'el_msg-rich_3', kind: 'rich_block', payload: checklist, epistemicStatus: 'inference' },
    ]);
    assert.strictEqual(env.payload.elements[1].payload, card, 'payload must be the stored block, not a wrapper');
  });

  test('oversized non-media block degrades to labelled text and emits a bounded warning', () => {
    const card = { id: 'large-card', kind: 'card', v: 1, title: 'Oversized', bodyMarkdown: 'x'.repeat(70_000) };
    const warnings = [];
    const previousWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let env;
    try {
      env = envelope.projectEnvelope({
        id: 'msg-large',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        content: 'cat replies',
        mentions: [],
        timestamp: 1_800_000_000_002,
        extra: { rich: { v: 1, blocks: [card] } },
      });
    } finally {
      console.warn = previousWarn;
    }
    assert.deepEqual(
      env.payload.elements.map(({ kind }) => kind),
      ['text', 'text'],
    );
    assert.match(env.payload.elements[1].payload.text, /card.*Oversized/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /rich block degraded/);
    assert.deepEqual(warnings[0][1], {
      messageId: 'msg-large',
      kind: 'card',
      bytes: Buffer.byteLength(JSON.stringify(card), 'utf8'),
      reason: 'bounds_exceeded',
    });
  });

  test('aggregate overflow remains visible within the 128-element and 256 KiB message limits', () => {
    const blocks = Array.from({ length: 130 }, (_, index) => ({
      id: `card-${index}`,
      kind: 'card',
      v: 1,
      title: `Card ${index}`,
    }));
    const warnings = [];
    const previousWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let env;
    try {
      env = envelope.projectEnvelope({
        id: 'msg-many',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        content: 'cat replies',
        mentions: [],
        timestamp: 1_800_000_000_002,
        extra: { rich: { v: 1, blocks } },
      });
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(env.payload.elements.length, 128);
    assert.match(env.payload.elements.at(-1).payload.text, /rich blocks degraded: 4; kinds: card/);
    assert.equal(warnings.length, 4);
    const total = env.payload.elements.reduce(
      (sum, element) => sum + Buffer.byteLength(JSON.stringify(element.payload)),
      0,
    );
    assert.ok(total <= 262_144);
  });

  test('total payload pressure degrades a block without producing an invalid envelope', () => {
    const blocks = Array.from({ length: 5 }, (_, index) => ({
      id: `diff-${index}`,
      kind: 'diff',
      v: 1,
      filePath: `file-${index}.ts`,
      diff: 'x'.repeat(60_000),
    }));
    const warnings = [];
    const previousWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let env;
    try {
      env = envelope.projectEnvelope({
        id: 'msg-total',
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        content: 'cat replies',
        mentions: [],
        timestamp: 1_800_000_000_002,
        extra: { rich: { v: 1, blocks } },
      });
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(env.payload.elements.filter((element) => element.kind === 'rich_block').length, 4);
    assert.match(env.payload.elements.at(-1).payload.text, /diff.*file-4\.ts/);
    assert.equal(warnings.length, 1);
    const total = env.payload.elements.reduce(
      (sum, element) => sum + Buffer.byteLength(JSON.stringify(element.payload)),
      0,
    );
    assert.ok(total <= 262_144);
  });

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

  test('INV-20: media_ref and rich_block payload objects remain open beyond their frozen minimum', () => {
    const base = pluginStoredMessage().extra.pluginMessage;
    const pluginMessage = {
      ...base,
      elements: [
        {
          elementId: 'el-media',
          kind: 'media_ref',
          payload: { type: 'image', reference: 'hmr_one', custom: { width: 4 } },
        },
        {
          elementId: 'el-rich',
          kind: 'rich_block',
          payload: { id: 'card-1', kind: 'card', v: 1, custom: true },
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
