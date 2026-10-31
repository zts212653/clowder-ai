/**
 * F297 (PR #3748 local R12 P1) — invocation record domain codec direct table.
 *
 * Transport validity ≠ record validity：envelope helper 只保证「这是一条真实的 HGETALL
 * 回复」；本表证明 domain codec 拥有**有限合法记录空间**的唯一定义：
 *
 *   absent | running(complete valid record) | not_running(complete valid record) | throw
 *
 * 任何不在合法空间内的形态都必须 throw——消费方（listRunningByThread / backfill /
 * scanAll / get）不再各自即兴枚举损坏形态。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeInvocationHash } from '../dist/domains/cats/services/stores/redis/invocation-record-redis-codec.js';

const ID = 'inv-codec-1';
const CTX = 'codec-table';

const validBase = {
  id: ID,
  threadId: 'thread-1',
  userId: 'user-1',
  targetCats: '["opus"]',
  intent: 'execute',
  idempotencyKey: 'idem-1',
  status: 'running',
  userMessageId: '',
  error: '',
  createdAt: '1700000000000',
  updatedAt: '1700000000001',
};

const entry = (data) => [null, data];

describe('invocation-record-redis-codec — the finite legal record space', () => {
  it('decodes a complete valid running record into the running arm', () => {
    const decoded = decodeInvocationHash(entry(validBase), ID, CTX);
    assert.equal(decoded.kind, 'running');
    assert.equal(decoded.record.id, ID);
    assert.equal(decoded.record.threadId, 'thread-1');
    assert.equal(decoded.record.userId, 'user-1');
    assert.deepEqual(decoded.record.targetCats, ['opus']);
    assert.equal(decoded.record.status, 'running');
    assert.equal(decoded.record.createdAt, 1700000000000);
    assert.equal(decoded.record.updatedAt, 1700000000001);
  });

  it('decodes every authoritative non-running status into the not_running arm (queued is NOT terminal but IS provably non-live)', () => {
    for (const status of ['queued', 'succeeded', 'failed', 'canceled']) {
      const decoded = decodeInvocationHash(entry({ ...validBase, status }), ID, CTX);
      assert.equal(decoded.kind, 'not_running', `status=${status}`);
      assert.equal(decoded.record.status, status);
    }
  });

  it('maps the authoritative-empty envelope ({} → null) to the absent arm', () => {
    assert.deepEqual(decodeInvocationHash(entry({}), ID, CTX), { kind: 'absent' });
  });

  it('propagates envelope-layer unknowns (transport invalidity)', () => {
    const transportUnknowns = [
      ['short reply', undefined],
      ['entry error', [new Error('transient'), null]],
      ['null payload', [null, null]],
      ['string payload', [null, 'wrong-type']],
      ['array payload', [null, []]],
      ['non-plain object', [null, new Date(0)]],
      ['non-string hash value', [null, { ...validBase, status: [] }]],
    ];
    for (const [label, e] of transportUnknowns) {
      assert.throws(() => decodeInvocationHash(e, ID, CTX), Error, label);
    }
  });

  it('throws on every record-invalid shape — the R12 probe set', () => {
    const recordUnknowns = [
      ['missing id', { ...validBase, id: undefined }],
      ['empty id', { ...validBase, id: '' }],
      ['id mismatch vs expected', { ...validBase, id: 'other-id' }],
      ['missing threadId', { ...validBase, threadId: undefined }],
      ['empty threadId', { ...validBase, threadId: '' }],
      ['missing userId', { ...validBase, userId: undefined }],
      ['empty userId', { ...validBase, userId: '' }],
      ['status outside the domain union', { ...validBase, status: 'banana' }],
      ['missing status', { ...validBase, status: undefined }],
      ['malformed targetCats JSON', { ...validBase, targetCats: 'not-json' }],
      ['targetCats not an array', { ...validBase, targetCats: '{"a":1}' }],
      ['targetCats with non-string member', { ...validBase, targetCats: '[123]' }],
      ['missing targetCats', { ...validBase, targetCats: undefined }],
      ['non-finite createdAt', { ...validBase, createdAt: 'abc' }],
      [
        'whitespace createdAt (Number(" ")===0 → epoch 0 → running judged over-grace zombie)',
        { ...validBase, createdAt: ' ' },
      ],
      ['whitespace updatedAt', { ...validBase, updatedAt: '\t' }],
      ['negative createdAt', { ...validBase, createdAt: '-1' }],
      [
        'unsafe-integer createdAt (precision collapse: 9007199254740993 → …992, two distinct strings → one number)',
        { ...validBase, createdAt: '9007199254740993' },
      ],
      ['unsafe-integer updatedAt', { ...validBase, updatedAt: '9007199254740993' }],
      ['non-integer createdAt', { ...validBase, createdAt: '17e3' }],
      ['missing createdAt', { ...validBase, createdAt: undefined }],
      ['non-finite updatedAt', { ...validBase, updatedAt: 'abc' }],
      ['missing updatedAt', { ...validBase, updatedAt: undefined }],
    ];
    for (const [label, data] of recordUnknowns) {
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      assert.throws(() => decodeInvocationHash(entry(clean), ID, CTX), Error, label);
    }
  });

  it('running-arm strictness gates every consumer action: no valid decode, no record escape', () => {
    // 防御性回归：decode 结果是 frozen union —— 消费方拿不到「半合法」记录。
    const decoded = decodeInvocationHash(entry(validBase), ID, CTX);
    assert.ok(Object.isFrozen(decoded.record.targetCats), 'targetCats array must be frozen');
  });
});
