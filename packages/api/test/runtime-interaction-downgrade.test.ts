/**
 * Downgrade/recovery regression for F306 Phase C question fields.
 *
 * The pre-Phase-C host reads stored `request.questions[]` with a strict schema
 * that has no `multiSelect` / `allowUnanswered`. This suite pins the recovery
 * procedure: a frozen copy of the base schema rejects the new records before
 * the rewrite and accepts every pending/history record after it, while
 * unrelated records stay byte-identical and replay is idempotent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRuntimeInteractionRequest } from '@cat-cafe/shared';
import { normalizeRuntimeInteractionRecord } from '../src/domains/runtime-interaction/RuntimeInteractionRecordModel.js';
import {
  APPLY_CONFIRMATION,
  assertApplyConfirmation,
  inspectStoredRecord,
  parseCliArgs,
  runDowngrade,
} from '../src/scripts/prepare-runtime-interaction-downgrade.js';
import { legacyRuntimeQuestionRequestSchema } from '../src/scripts/runtime-interaction-downgrade/legacy-question-schema.js';

const KEY_PREFIX = 'cat-cafe:';
const ACTIVE_KEY = `${KEY_PREFIX}runtime-interaction:active`;
const PENDING_KEY = `${KEY_PREFIX}runtime-interaction:user:user-1:pending`;
const INVOCATION_KEY = `${KEY_PREFIX}runtime-interaction:invocation:inv-1:active`;

class FakeRedis {
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
  zsets = new Map<string, Set<string>>();
  strings = new Map<string, string>();
  failNextExec = false;
  /** First queued command matching this predicate resolves as a Redis error. */
  failExecWhen = null;
  /** Key whose request-rewrite transaction throws instead of committing. */
  failRewriteFor = null;

  seedHash(key, fields) {
    this.hashes.set(key, new Map(Object.entries(fields)));
  }

  seedSet(key, members) {
    this.sets.set(key, new Set(members));
  }

  seedZset(key, members) {
    this.zsets.set(key, new Set(members));
  }

  seedString(key, value) {
    this.strings.set(key, value);
  }

  multi() {
    return new FakeTransaction(this);
  }

  async scan(_cursor, _matchToken, pattern) {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = new Set([...this.hashes.keys(), ...this.sets.keys(), ...this.zsets.keys()]);
    return ['0', [...keys].filter((key) => key.startsWith(prefix))];
  }

  async type(key) {
    if (this.hashes.has(key)) return 'hash';
    if (this.sets.has(key)) return 'set';
    if (this.zsets.has(key)) return 'zset';
    if (this.strings.has(key)) return 'string';
    return 'none';
  }

  async hgetall(key) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  applyHset(key, field, value) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key).set(field, value);
  }

  async hset(key, field, value) {
    this.applyHset(key, field, value);
    return 1;
  }

  applyHdel(key, field) {
    return this.hashes.get(key)?.delete(field) ?? false;
  }

  async hdel(key, field) {
    return this.applyHdel(key, field) ? 1 : 0;
  }

  applyZrem(key, member) {
    return this.zsets.get(key)?.delete(member) ?? false;
  }

  async zrem(key, member) {
    return this.applyZrem(key, member) ? 1 : 0;
  }

  applySrem(key, member) {
    return this.sets.get(key)?.delete(member) ?? false;
  }

  async srem(key, member) {
    return this.applySrem(key, member) ? 1 : 0;
  }

  hash(key) {
    return this.hashes.get(key);
  }

  requestOf(key) {
    const raw = this.hash(key)?.get('request');
    return raw ? JSON.parse(raw) : null;
  }
}

/** MULTI/EXEC model: replies are per-command `[error, result]` tuples like ioredis. */
class FakeTransaction {
  ops = [];

  constructor(redis) {
    this.redis = redis;
  }

  hset(key, field, value) {
    this.ops.push({ kind: 'hset', key, field, value });
    return this;
  }

  hdel(key, field) {
    this.ops.push({ kind: 'hdel', key, field });
    return this;
  }

  zrem(key, member) {
    this.ops.push({ kind: 'zrem', key, member });
    return this;
  }

  srem(key, member) {
    this.ops.push({ kind: 'srem', key, member });
    return this;
  }

  apply(op) {
    if (op.kind === 'hset') return this.redis.applyHset(op.key, op.field, op.value);
    if (op.kind === 'hdel') return this.redis.applyHdel(op.key, op.field);
    if (op.kind === 'zrem') return this.redis.applyZrem(op.key, op.member);
    return this.redis.applySrem(op.key, op.member);
  }

  async exec() {
    if (this.redis.failNextExec) {
      this.redis.failNextExec = false;
      throw new Error('injected EXEC failure');
    }
    const rewriteKey = this.redis.failRewriteFor;
    const isRewrite = this.ops.some((op) => op.kind === 'hset' && op.field === 'request' && op.key === rewriteKey);
    if (isRewrite) {
      this.redis.failRewriteFor = null;
      throw new Error('injected request rewrite failure');
    }
    const failing = this.redis.failExecWhen;
    this.redis.failExecWhen = null;
    const replies = [];
    let failedCommand = false;
    for (const op of this.ops) {
      if (!failedCommand && failing?.(op)) {
        // Redis rejects only this command; the rest of the transaction commits.
        failedCommand = true;
        replies.push([new Error('WRONGTYPE injected command failure'), null]);
        continue;
      }
      this.apply(op);
      replies.push([null, 1]);
    }
    this.ops = [];
    return replies;
  }
}

function questionRequest(overrides = {}) {
  return {
    version: 1,
    interactionId: 'ix-pending',
    kind: 'question',
    owner: { userId: 'user-1', threadId: 'thread-1', catId: 'chrys', invocationId: 'inv-1' },
    provider: { providerId: 'chrys', method: '_chrys/request_input', requestId: 'ask-1' },
    createdAt: 10,
    title: 'iCode 需要你的回答',
    questions: [{ id: 'q1', header: '部署', question: '选择目标', multiSelect: true, allowUnanswered: true }],
    ...overrides,
  };
}

function record(request, overrides = {}) {
  return {
    request: JSON.stringify(request),
    status: 'pending',
    hostEpoch: 'host-1',
    updatedAt: '20',
    revision: '3',
    returnBinding: JSON.stringify({ kind: 'provider_waiter' }),
    ...overrides,
  };
}

function seededRedis() {
  const redis = new FakeRedis();
  redis.seedHash(`${KEY_PREFIX}runtime-interaction:ix-pending`, record(questionRequest(), { submission: '{}' }));
  redis.seedHash(
    `${KEY_PREFIX}runtime-interaction:ix-history`,
    record(questionRequest({ interactionId: 'ix-history' }), {
      status: 'answered',
      revision: '4',
      terminal: JSON.stringify({ status: 'answered', reasonCode: 'answered', settledAt: 30 }),
    }),
  );
  redis.seedHash(
    `${KEY_PREFIX}runtime-interaction:ix-clean`,
    record(
      questionRequest({
        interactionId: 'ix-clean',
        questions: [{ id: 'q1', header: '部署', question: '选择目标' }],
      }),
    ),
  );
  redis.seedHash(
    `${KEY_PREFIX}runtime-interaction:ix-approval`,
    record(
      {
        version: 1,
        interactionId: 'ix-approval',
        kind: 'approval',
        owner: { userId: 'user-1', threadId: 'thread-1', catId: 'chrys', invocationId: 'inv-1' },
        provider: { providerId: 'chrys', method: '_chrys/request_permission', requestId: 'ask-2' },
        createdAt: 10,
        title: '批准',
        decisions: [{ id: 'accept', label: '允许', outcome: 'accept' }],
      },
      { status: 'answered' },
    ),
  );
  redis.seedSet(ACTIVE_KEY, ['ix-pending', 'ix-clean']);
  redis.seedSet(INVOCATION_KEY, ['ix-pending']);
  redis.seedZset(PENDING_KEY, ['ix-pending', 'ix-clean']);
  return redis;
}

describe('runtime interaction downgrade recovery', () => {
  it('requires an explicit target even when the host environment points at production', () => {
    assert.throws(() => parseCliArgs([], {}), /--redis-url/);
    assert.throws(() => parseCliArgs([], { REDIS_URL: 'redis://127.0.0.1:6399' }), /--redis-url/);
  });

  it('defaults to a zero-write dry-run after explicit target selection and requires apply confirmation', () => {
    const target = ['--redis-url', 'redis://127.0.0.1:6398'];
    const defaults = parseCliArgs(target, {});
    assert.equal(defaults.apply, false);
    assert.equal(defaults.keyPrefix, KEY_PREFIX);
    assert.equal(defaults.redisUrl, 'redis://127.0.0.1:6398');
    assert.equal(parseCliArgs([...target, '--', '--dry-run'], {}).apply, false);
    assert.equal(parseCliArgs([...target, '--key-prefix', 'test'], {}).keyPrefix, 'test:');
    assert.equal(parseCliArgs([...target, '--now', '1234'], {}).now, 1234);
    assert.throws(() => parseCliArgs(['--now', '-1'], {}), /non-negative integer/);
    assert.throws(() => parseCliArgs(['--unknown'], {}), /Unknown argument/);
    assert.throws(() => assertApplyConfirmation({ ...defaults, apply: true }), /requires --confirm/);
    assert.doesNotThrow(() => assertApplyConfirmation({ ...defaults, apply: true, confirm: APPLY_CONFIRMATION }));
  });

  it('refuses any 6399 target before I/O, including dry-run and generic apply confirmation', () => {
    for (const redisUrl of ['redis://127.0.0.1:6399', 'rediss://runtime.example:6399', 'redis://[::1]:06399']) {
      const args = parseCliArgs(['--redis-url', redisUrl], {});
      assert.throws(() => assertApplyConfirmation(args), /6399.*--i-understand-runtime-redis/);
      assert.throws(
        () => assertApplyConfirmation({ ...args, apply: true, confirm: APPLY_CONFIRMATION }),
        /6399.*--i-understand-runtime-redis/,
      );
    }
  });

  it('requires independent runtime acknowledgement and apply confirmation for an explicit 6399 target', () => {
    const args = parseCliArgs(['--redis-url', 'redis://127.0.0.1:6399', '--i-understand-runtime-redis'], {});
    assert.doesNotThrow(() => assertApplyConfirmation(args));
    assert.throws(() => assertApplyConfirmation({ ...args, apply: true }), /requires --confirm/);
    assert.doesNotThrow(() => assertApplyConfirmation({ ...args, apply: true, confirm: APPLY_CONFIRMATION }));
    assert.throws(
      () => assertApplyConfirmation(parseCliArgs(['--redis-url', 'https://example.invalid'], {})),
      /redis:\/\//,
    );
  });

  it('dry-run reports the plan without writing or settling anything', async () => {
    const redis = seededRedis();
    const summary = await runDowngrade(redis, { apply: false, keyPrefix: KEY_PREFIX, now: 1000 });

    assert.equal(summary.interactionHashes, 4);
    assert.equal(summary.questionRecords, 3);
    assert.equal(summary.rewritable, 2);
    assert.equal(summary.pendingSettled, 1);
    assert.equal(summary.recovered, 0);
    assert.equal(summary.rewritten, 0);
    assert.equal(summary.untouched, 2);
    assert.equal(summary.invalid, 0);
    assert.equal(redis.hash(`${KEY_PREFIX}runtime-interaction:ix-pending`).get('status'), 'pending');
    assert.match(redis.hash(`${KEY_PREFIX}runtime-interaction:ix-pending`).get('request'), /multiSelect/);
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-pending'), true);
    assert.equal(redis.sets.get(ACTIVE_KEY).has('ix-pending'), true);
  });

  it('settles pending cards and rewrites pending plus retained history into the base strict schema', async () => {
    const redis = seededRedis();
    const pendingKey = `${KEY_PREFIX}runtime-interaction:ix-pending`;
    const historyKey = `${KEY_PREFIX}runtime-interaction:ix-history`;
    const beforePending = redis.requestOf(pendingKey);
    const beforeHistory = redis.requestOf(historyKey);

    // The frozen base reader must reject the stored shape before recovery.
    assert.equal(legacyRuntimeQuestionRequestSchema.safeParse(beforePending).success, false);
    assert.equal(legacyRuntimeQuestionRequestSchema.safeParse(beforeHistory).success, false);

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.rewritable, 2);
    assert.equal(summary.pendingSettled, 1);
    assert.equal(summary.recovered, 0);
    assert.equal(summary.rewritten, 2);
    assert.equal(summary.invalid, 0);

    const pending = redis.hash(pendingKey);
    assert.equal(pending.get('status'), 'invalidated');
    assert.equal(pending.get('revision'), '4');
    assert.equal(pending.get('updatedAt'), '1000');
    assert.equal(pending.has('submission'), false);
    assert.deepEqual(JSON.parse(pending.get('terminal')), {
      status: 'invalidated',
      reasonCode: 'host_restarted',
      settledAt: 1000,
    });
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-pending'), false);
    assert.equal(redis.sets.get(ACTIVE_KEY).has('ix-pending'), false);
    assert.equal(redis.sets.get(INVOCATION_KEY).has('ix-pending'), false);

    const history = redis.hash(historyKey);
    assert.equal(history.get('status'), 'answered');
    assert.equal(
      history.get('terminal'),
      JSON.stringify({ status: 'answered', reasonCode: 'answered', settledAt: 30 }),
      'terminal history must not be re-settled',
    );

    for (const key of [pendingKey, historyKey]) {
      const rewritten = redis.requestOf(key);
      assert.equal('multiSelect' in rewritten.questions[0], false);
      assert.equal('allowUnanswered' in rewritten.questions[0], false);
      assert.equal(legacyRuntimeQuestionRequestSchema.safeParse(rewritten).success, true);
      // The current reader and store normalizer stay backward compatible with
      // the rewritten shape, so a forward upgrade does not need another repair.
      parseRuntimeInteractionRequest(rewritten);
      const normalized = normalizeRuntimeInteractionRecord({
        request: rewritten,
        status: 'invalidated',
        hostEpoch: 'host-1',
        updatedAt: 1000,
      });
      assert.equal(normalized.request.kind, 'question');
    }

    // Unrelated records are byte-identical.
    assert.equal(
      redis.hash(`${KEY_PREFIX}runtime-interaction:ix-clean`).get('request'),
      JSON.stringify(
        questionRequest({
          interactionId: 'ix-clean',
          questions: [{ id: 'q1', header: '部署', question: '选择目标' }],
        }),
      ),
    );
    const approvalRequest = redis.hash(`${KEY_PREFIX}runtime-interaction:ix-approval`).get('request');
    assert.match(approvalRequest, /"kind":"approval"/);

    const replay = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
    assert.equal(replay.rewritable, 0);
    assert.equal(replay.pendingSettled, 0);
    assert.equal(replay.recovered, 0);
    assert.equal(replay.rewritten, 0);
  });

  it('leaves no partial settlement when the commit is interrupted, and rerun completes it', async () => {
    const redis = seededRedis();
    const pendingKey = `${KEY_PREFIX}runtime-interaction:ix-pending`;
    redis.failNextExec = true;
    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });

    // A refused commit is a failure receipt, never a successful downgrade.
    // The retained history record has no settlement to write and still commits.
    assert.equal(summary.rewritten, 1);
    assert.equal(summary.pendingSettled, 1);
    assert.equal(summary.failures.length, 1);
    assert.match(summary.failures[0].reason, /injected EXEC failure/);

    // MULTI/EXEC is atomic: the interrupted commit wrote nothing.
    const pending = redis.hash(pendingKey);
    assert.equal(pending.get('status'), 'pending');
    assert.match(pending.get('request'), /multiSelect/);
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-pending'), true);
    assert.equal(redis.sets.get(ACTIVE_KEY).has('ix-pending'), true);
    assert.equal(redis.sets.get(INVOCATION_KEY).has('ix-pending'), true);

    const retry = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(retry.pendingSettled, 1);
    assert.equal(retry.recovered, 0);
    assert.equal(retry.rewritten, 1);
    assert.equal(retry.invalid, 0);
    assert.deepEqual(retry.failures, []);
    assert.equal(pending.get('status'), 'invalidated');
    assert.deepEqual(JSON.parse(pending.get('terminal')), {
      status: 'invalidated',
      reasonCode: 'host_restarted',
      settledAt: 1000,
    });
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-pending'), false);
    assert.equal(redis.sets.get(ACTIVE_KEY).has('ix-pending'), false);
    assert.equal(redis.sets.get(INVOCATION_KEY).has('ix-pending'), false);
    assert.equal('multiSelect' in redis.requestOf(pendingKey).questions[0], false);
  });

  it('reports a per-command EXEC error and keeps the record detectable for replay', async () => {
    const redis = seededRedis();
    const pendingKey = `${KEY_PREFIX}runtime-interaction:ix-pending`;
    // Fail the pending-index ZREM the way a WRONGTYPE index does while every
    // other queued command still commits.
    redis.failExecWhen = (op) => op.kind === 'zrem' && op.key === PENDING_KEY;

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.rewritten, 1, 'only the record whose cleanup succeeded counts as rewritten');
    assert.equal(summary.failures.length, 1);
    assert.match(summary.failures[0].reason, /EXEC command \d+ failed: WRONGTYPE injected command failure/);
    assert.equal(
      redis.hash(pendingKey).get('request').includes('multiSelect'),
      true,
      'a failed cleanup must keep the detection fields so replay can finish',
    );
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-pending'), true);

    const replay = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
    assert.deepEqual(replay.failures, []);
    assert.equal(replay.rewritten, 1);
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-pending'), false);
    assert.equal('multiSelect' in redis.requestOf(pendingKey).questions[0], false);
  });

  it('redoes a rejected submission cleanup on replay even though the marker landed', async () => {
    const redis = seededRedis();
    const pendingKey = `${KEY_PREFIX}runtime-interaction:ix-pending`;
    // Redis applies the rest of the transaction when one command is rejected:
    // the terminal, revision and marker commit while HDEL submission fails.
    redis.failExecWhen = (op) => op.kind === 'hdel' && op.field === 'submission';

    const first = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(first.failures.length, 1);
    assert.match(first.failures[0].reason, /EXEC command \d+ failed: WRONGTYPE injected command failure/);
    const partial = redis.hash(pendingKey);
    assert.match(partial.get('request'), /multiSelect/);
    assert.equal(partial.has('submission'), true, 'the rejected cleanup leaves the submission behind');
    assert.equal(
      partial.get('downgradeSettledRevision'),
      partial.get('revision'),
      'the marker commits with the rest of the transaction',
    );

    const retry = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
    assert.deepEqual(retry.failures, []);
    assert.equal(retry.rewritten, 1);
    const repaired = redis.hash(pendingKey);
    assert.equal(repaired.has('submission'), false, 'a matching marker must not skip the rejected cleanup');
    assert.equal(repaired.has('downgradeSettledRevision'), false);
    assert.equal('multiSelect' in redis.requestOf(pendingKey).questions[0], false);

    const third = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 3000 });
    assert.equal(third.rewritten, 0);
    assert.equal(repaired.get('revision'), '5');
  });

  it('refuses a record whose pending index has the wrong type instead of stripping it', async () => {
    const redis = new FakeRedis();
    const key = `${KEY_PREFIX}runtime-interaction:ix-wrongtype`;
    redis.seedHash(key, record(questionRequest({ interactionId: 'ix-wrongtype' }), { submission: '{}' }));
    redis.seedString(PENDING_KEY, 'not-a-sorted-set');

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.rewritten, 0);
    assert.equal(summary.failures.length, 1);
    assert.match(summary.failures[0].reason, /has type string; expected zset/);

    const untouched = redis.hash(key);
    assert.equal(untouched.get('status'), 'pending');
    assert.equal(untouched.get('revision'), '3');
    assert.equal(untouched.has('submission'), true);
    assert.match(untouched.get('request'), /multiSelect/);
    assert.equal(redis.strings.get(PENDING_KEY), 'not-a-sorted-set', 'the operator repairs the index, not the tool');
  });

  it('rebuilds the same record and indexes when the request rewrite is interrupted', async () => {
    const pendingKey = `${KEY_PREFIX}runtime-interaction:ix-pending`;
    const interrupted = seededRedis();
    interrupted.failRewriteFor = pendingKey;

    const first = await runDowngrade(interrupted, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(first.failures.length, 1);
    assert.match(first.failures[0].reason, /injected request rewrite failure/);
    // The settlement and its index cleanup committed; only the rewrite is left,
    // and the record still carries the fields this tool detects it by.
    assert.equal(interrupted.hash(pendingKey).get('status'), 'invalidated');
    assert.match(interrupted.hash(pendingKey).get('request'), /multiSelect/);
    assert.equal(interrupted.zsets.get(PENDING_KEY).has('ix-pending'), false);
    assert.equal(interrupted.sets.get(ACTIVE_KEY).has('ix-pending'), false);
    assert.equal(interrupted.sets.get(INVOCATION_KEY).has('ix-pending'), false);

    const replay = await runDowngrade(interrupted, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
    assert.deepEqual(replay.failures, []);
    assert.equal(replay.rewritten, 1);

    // A rerun must land on the same record and index state as an uninterrupted run.
    const clean = seededRedis();
    await runDowngrade(clean, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.deepEqual([...interrupted.hash(pendingKey).entries()], [...clean.hash(pendingKey).entries()]);
    assert.deepEqual([...interrupted.zsets.get(PENDING_KEY)].sort(), [...clean.zsets.get(PENDING_KEY)].sort());
    assert.deepEqual([...interrupted.sets.get(ACTIVE_KEY)].sort(), [...clean.sets.get(ACTIVE_KEY)].sort());
    assert.deepEqual([...interrupted.sets.get(INVOCATION_KEY)].sort(), [...clean.sets.get(INVOCATION_KEY)].sort());
    assert.equal(JSON.parse(interrupted.hash(pendingKey).get('terminal')).settledAt, 1000);
  });

  it('bumps a host-restarted invalidation that has no submission to prove its revision', async () => {
    // A normal pending provider question is createStaged (1) + anchor (2) with
    // no `submission`, so nothing but the revision distinguishes a settled
    // record from one the old runner stopped before its revision write.
    const terminal = JSON.stringify({ status: 'invalidated', reasonCode: 'host_restarted', settledAt: 1000 });
    const redis = new FakeRedis();
    const key = `${KEY_PREFIX}runtime-interaction:ix-nosub`;
    redis.seedHash(
      key,
      record(questionRequest({ interactionId: 'ix-nosub' }), {
        status: 'invalidated',
        revision: '2',
        updatedAt: '1000',
        terminal,
      }),
    );
    redis.seedSet(ACTIVE_KEY, ['ix-nosub']);
    redis.seedSet(INVOCATION_KEY, ['ix-nosub']);
    redis.seedZset(PENDING_KEY, ['ix-nosub']);

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
    assert.equal(summary.recovered, 1);
    assert.equal(summary.rewritten, 1);
    assert.deepEqual(summary.failures, []);

    const repaired = redis.hash(key);
    assert.equal(repaired.get('terminal'), terminal, 'the recorded settlement is preserved');
    assert.equal(repaired.get('revision'), '3', 'the settlement revision must exceed the pending revision');
    assert.equal(repaired.get('updatedAt'), '1000');
    assert.equal(repaired.has('submission'), false);
    assert.equal(repaired.has('downgradeSettledRevision'), false, 'the marker never outlives the downgrade');
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-nosub'), false);
    assert.equal('multiSelect' in redis.requestOf(key).questions[0], false);

    const replay = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 3000 });
    assert.equal(replay.rewritten, 0);
    assert.equal(repaired.get('revision'), '3', 'a completed repair is a no-op');
  });

  it('finishes an invalidation interrupted between the terminal write and its bookkeeping', async () => {
    const terminal = JSON.stringify({ status: 'invalidated', reasonCode: 'host_restarted', settledAt: 1000 });
    const cases = [
      // The old runner wrote status, terminal, updatedAt, revision and the
      // submission removal separately; a stop can land after any of them.
      { name: 'stop after terminal', fields: { updatedAt: '20', revision: '3', submission: '{}' } },
      { name: 'stop after updatedAt', fields: { updatedAt: '1000', revision: '3', submission: '{}' } },
      { name: 'stop after revision', fields: { updatedAt: '1000', revision: '4', submission: '{}' } },
    ];
    for (const { name, fields } of cases) {
      const redis = new FakeRedis();
      const key = `${KEY_PREFIX}runtime-interaction:ix-partial`;
      redis.seedHash(
        key,
        record(questionRequest({ interactionId: 'ix-partial' }), {
          status: 'invalidated',
          terminal,
          ...fields,
        }),
      );
      redis.seedSet(ACTIVE_KEY, ['ix-partial']);
      redis.seedSet(INVOCATION_KEY, ['ix-partial']);
      redis.seedZset(PENDING_KEY, ['ix-partial']);

      const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
      assert.equal(summary.recovered, 1, name);
      assert.equal(summary.rewritten, 1, name);
      assert.deepEqual(summary.failures, [], name);

      const repaired = redis.hash(key);
      assert.equal(repaired.get('terminal'), terminal, `${name}: the recorded settlement is preserved`);
      assert.equal(repaired.get('updatedAt'), '1000', `${name}: updatedAt follows the terminal, not the run`);
      assert.equal(repaired.get('revision'), String(Number(fields.revision) + 1), name);
      assert.equal(repaired.has('submission'), false, `${name}: submission cleanup completes`);
      assert.equal(redis.zsets.get(PENDING_KEY).has('ix-partial'), false, name);
      assert.equal('multiSelect' in redis.requestOf(key).questions[0], false, name);

      const replay = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 3000 });
      assert.equal(replay.rewritten, 0, `${name}: a completed repair is a no-op`);
    }
  });

  it('rewrites a terminal that disagrees with the record status instead of trusting it', async () => {
    const redis = new FakeRedis();
    const key = `${KEY_PREFIX}runtime-interaction:ix-mismatch`;
    redis.seedHash(
      key,
      record(questionRequest({ interactionId: 'ix-mismatch' }), {
        status: 'invalidated',
        revision: '4',
        updatedAt: '500',
        terminal: JSON.stringify({ status: 'answered', reasonCode: 'answered', settledAt: 500 }),
      }),
    );
    redis.seedZset(PENDING_KEY, ['ix-mismatch']);

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 2000 });
    assert.equal(summary.rewritten, 1);
    assert.deepEqual(summary.failures, []);
    assert.deepEqual(JSON.parse(redis.hash(key).get('terminal')), {
      status: 'invalidated',
      reasonCode: 'host_restarted',
      settledAt: 2000,
    });
    assert.equal(redis.hash(key).get('revision'), '5');
  });

  it('finishes an invalidated settlement left without a terminal by an earlier interrupted run', async () => {
    const redis = new FakeRedis();
    const key = `${KEY_PREFIX}runtime-interaction:ix-damaged`;
    redis.seedHash(
      key,
      record(questionRequest({ interactionId: 'ix-damaged' }), {
        status: 'invalidated',
        revision: '4',
        updatedAt: '999',
        submission: '{}',
      }),
    );
    redis.seedSet(ACTIVE_KEY, ['ix-damaged']);
    redis.seedSet(INVOCATION_KEY, ['ix-damaged']);
    redis.seedZset(PENDING_KEY, ['ix-damaged']);

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.recovered, 1);
    assert.equal(summary.pendingSettled, 0);
    assert.equal(summary.rewritten, 1);

    const damaged = redis.hash(key);
    assert.equal(damaged.get('status'), 'invalidated');
    assert.equal(damaged.get('revision'), '5');
    assert.equal(damaged.get('updatedAt'), '1000');
    assert.equal(damaged.has('submission'), false);
    assert.deepEqual(JSON.parse(damaged.get('terminal')), {
      status: 'invalidated',
      reasonCode: 'host_restarted',
      settledAt: 1000,
    });
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-damaged'), false);
    assert.equal(redis.sets.get(ACTIVE_KEY).has('ix-damaged'), false);
    assert.equal(redis.sets.get(INVOCATION_KEY).has('ix-damaged'), false);
    assert.equal('multiSelect' in redis.requestOf(key).questions[0], false);
  });

  it('cleans stale indexes on a settled invalidated record without changing its terminal or revision', async () => {
    const redis = new FakeRedis();
    const key = `${KEY_PREFIX}runtime-interaction:ix-settled`;
    const terminal = JSON.stringify({ status: 'invalidated', reasonCode: 'provider_cancelled', settledAt: 50 });
    redis.seedHash(
      key,
      record(questionRequest({ interactionId: 'ix-settled' }), {
        status: 'invalidated',
        revision: '4',
        updatedAt: '50',
        terminal,
      }),
    );
    redis.seedSet(ACTIVE_KEY, ['ix-settled']);
    redis.seedSet(INVOCATION_KEY, ['ix-settled']);
    redis.seedZset(PENDING_KEY, ['ix-settled']);

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.recovered, 1);
    assert.equal(summary.rewritten, 1);

    const settled = redis.hash(key);
    assert.equal(settled.get('revision'), '4');
    assert.equal(settled.get('terminal'), terminal);
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-settled'), false);
    assert.equal(redis.sets.get(ACTIVE_KEY).has('ix-settled'), false);
    assert.equal(redis.sets.get(INVOCATION_KEY).has('ix-settled'), false);
    assert.equal('multiSelect' in redis.requestOf(key).questions[0], false);
  });

  it('refuses to rewrite a record the base strict reader would still reject', async () => {
    const redis = new FakeRedis();
    const key = `${KEY_PREFIX}runtime-interaction:ix-extra`;
    const request = questionRequest({
      interactionId: 'ix-extra',
      questions: [{ id: 'q1', header: '部署', question: '选择目标', multiSelect: true, futureField: { note: 'keep' } }],
    });
    redis.seedHash(key, record(request));
    redis.seedZset(PENDING_KEY, ['ix-extra']);
    const before = redis.hash(key).get('request');

    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.rewritten, 0);
    assert.equal(summary.invalid, 1);
    assert.match(summary.failures[0].reason, /futureField/);
    assert.equal(redis.hash(key).get('request'), before);
    assert.equal(redis.hash(key).get('status'), 'pending');
    assert.equal(redis.zsets.get(PENDING_KEY).has('ix-extra'), true);
  });

  it('rejects malformed requests and key/id mismatches without aborting the scan', async () => {
    const redis = new FakeRedis();
    redis.seedHash(`${KEY_PREFIX}runtime-interaction:ix-bad-json`, {
      request: '{not json',
      status: 'pending',
      hostEpoch: 'host-1',
      updatedAt: '1',
      revision: '1',
    });
    redis.seedHash(
      `${KEY_PREFIX}runtime-interaction:ix-renamed`,
      record(questionRequest({ interactionId: 'ix-other' })),
    );
    const summary = await runDowngrade(redis, { apply: true, keyPrefix: KEY_PREFIX, now: 1000 });
    assert.equal(summary.invalid, 2);
    assert.deepEqual(
      summary.failures.map((failure) => failure.reason),
      ['request is not valid JSON', 'detail key does not match interactionId'],
    );
  });

  it('inspects keys with a non-default prefix', () => {
    const action = inspectStoredRecord(
      'test:runtime-interaction:ix-prefixed',
      record(questionRequest({ interactionId: 'ix-prefixed' })),
      'test:',
    );
    assert.equal(action.kind, 'rewrite');
  });
});
