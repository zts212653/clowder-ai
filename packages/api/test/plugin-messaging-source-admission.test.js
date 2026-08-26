/**
 * M0-A/C Host source admission — scalar strings, WireUInt53 values, and
 * fail-closed historical hydration must share one boundary.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { MESSAGING_BOUNDS } from '@clowder-ai/plugin-contract';

/** @type {typeof import('../dist/domains/messaging/contract/validate.js')} */
let validate;
/** @type {typeof import('../dist/domains/messaging/envelope.js')} */
let envelope;

before(async () => {
  validate = await import('../dist/domains/messaging/contract/validate.js');
  envelope = await import('../dist/domains/messaging/envelope.js');
});

function draftWithElementId(elementId) {
  return {
    address: { kind: 'thread_handle', handle: 'th_abc123' },
    idempotencyKey: 'idem-1',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId, kind: 'text', payload: { text: 'hello' } }],
    },
  };
}

function validAppend(overrides = {}) {
  return {
    handle: { kind: 'message', token: 'msg-1' },
    operationId: 'op-1',
    baseRevision: 1,
    elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'more' } }],
    ...overrides,
  };
}

function pluginExtra(overrides = {}) {
  return {
    instanceId: 'inst-a',
    revision: 2,
    provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
    elements: [
      { elementId: 'el-1', kind: 'text', payload: { text: 'hello' } },
      {
        elementId: 'el-2',
        kind: 'text',
        payload: { text: 'more' },
        epistemicStatus: 'inference',
      },
    ],
    outputRevision: 2,
    outputSequence: 9,
    appendOps: [{ operationId: 'op-1', elementIds: ['el-2'], baseRevision: 1 }],
    ...overrides,
  };
}

function storedPluginMessage(overrides = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'hello',
    mentions: [],
    timestamp: 1_800_000_000_000,
    extra: { pluginMessage: pluginExtra() },
    ...overrides,
  };
}

function expectValidationError(fn) {
  assert.throws(fn, (error) => error?.name === 'MessagingError' && error?.code === 'VALIDATION');
}

describe('M0 source admission — Unicode scalar values', () => {
  test('accepts an identifier at the scalar maximum even when UTF-16 uses two code units per scalar', () => {
    const elementId = '\u{1F408}'.repeat(MESSAGING_BOUNDS.maxElementIdLength);
    assert.equal(validate.validateDraft(draftWithElementId(elementId)).payload.elements[0].elementId, elementId);
  });

  test('rejects an identifier above the scalar maximum and any isolated surrogate', () => {
    const tooManyScalars = '\u{1F408}'.repeat(MESSAGING_BOUNDS.maxElementIdLength + 1);
    expectValidationError(() => validate.validateDraft(draftWithElementId(tooManyScalars)));
    expectValidationError(() => validate.validateDraft(draftWithElementId('\uD800')));
  });
});

describe('M0 source admission — WireUInt53', () => {
  test('rejects an unsafe append revision before the operation is admitted', () => {
    expectValidationError(() =>
      validate.validateAppendInput(validAppend({ baseRevision: Number.MAX_SAFE_INTEGER + 1 })),
    );
  });
});

describe('M0 historical-value admission', () => {
  test('hydrates stored identifiers with scalar-counted bounds', () => {
    const instanceId = '\u{1F408}'.repeat(256);
    const raw = pluginExtra({
      instanceId,
      provenance: { origin: { kind: 'plugin', instanceId }, epistemicStatus: 'inference' },
    });
    assert.ok(envelope.parsePluginMessageExtra(raw));
  });

  test('rejects unsafe stored sequence values and non-scalar identifiers', () => {
    assert.equal(envelope.parsePluginMessageExtra(pluginExtra({ outputSequence: Number.MAX_SAFE_INTEGER + 1 })), null);
    assert.equal(
      envelope.parsePluginMessageExtra(
        pluginExtra({ appendOps: [{ operationId: '\uD800', elementIds: ['el-2'], baseRevision: 1 }] }),
      ),
      null,
    );
  });

  test('fails closed instead of throwing when a historical timestamp cannot project to occurredAt', () => {
    assert.equal(envelope.projectEnvelope(storedPluginMessage({ timestamp: Number.NaN })), null);
  });
});
