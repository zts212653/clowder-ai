import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { routingSelectionFacts } from '../dist/domains/routing-context/selection/RoutingSelectionFacts.js';
import { RoutingSelectionService } from '../dist/domains/routing-context/selection/RoutingSelectionService.js';

test('mixed Claude/Codex facts retain dedicated windows and reset dates in about 300 tokens', () => {
  const obs = Date.parse('2026-11-16T08:00:00Z');
  const window = (poolKind, key, left, reset) => ({
    poolId: `p-${poolKind}-${key}`,
    poolKind,
    windowKey: key,
    kind: 'seven_day',
    applicability: 'unknown',
    freshness: 'stale',
    remainingPercent: left,
    resetAt: Date.parse(reset),
  });
  const account = (label, windows, observedAt) => ({
    accountLabel: label,
    state: 'stale',
    reason: 'observation_stale',
    observedAt,
    windows,
    evidenceRef: label,
  });
  const claude = account(
    'Claude (OAuth)',
    [
      window('claude-subscription', 'seven_day', 10, '2026-11-16T23:00Z'),
      {
        ...window('claude-subscription', 'seven_day_overage_included', 42, '2026-11-16T23:00Z'),
        observedModel: 'claude-fable-5-2',
      },
    ],
    obs - 1800000,
  );
  const spare = account(
    '备用 Claude 订阅号',
    [
      window('claude-subscription', 'five_hour', 100, '2026-11-16T11:10Z'),
      window('claude-subscription', 'seven_day', 100, '2026-11-23T04:00Z'),
      window('claude-subscription', 'seven_day_overage_included', 100, '2026-11-23T04:00Z'),
    ],
    obs - 1790000,
  );
  const codex = (label, left, reset, offset = 0) => ({
    ...account(label, [window('codex-main', undefined, left, reset)], obs - 11 * 3600000 + offset),
    plan: 'pro',
  });
  const candidates = ['fable-5', 'haiku55', 'opus', 'sonnet', 'opus55'].map((catId) => ({
    binding: { catId, capacityFacts: { current: claude, switchRequired: [spare] } },
    availability: 'available',
    reasons: [],
  }));
  candidates.push({
    binding: {
      catId: 'codex61-sol',
      capacityFacts: {
        current: codex('主号', 78, '2026-11-20T16:11Z'),
        switchRequired: [
          codex('备用一号', 1, '2026-11-19T07:50Z', 5),
          codex('备用二号', 0, '2026-11-09T21:20Z', -8),
          codex('备用三号', 0, '2026-11-16T17:33Z', 9),
        ],
      },
    },
    availability: 'available',
    reasons: [],
  });
  const facts = routingSelectionFacts({ resolution: { state: 'fresh', snapshot: { candidates } } });
  assert.match(facts, /账号剩余/, 'the reader must not infer whether percentages are used or remaining');
  for (const value of ['Fable7d', '42%', '10%', '100%', '需切号才能用(G1)', '2026-11', '16T23:00Z', '23T04:00Z'])
    assert.ok(facts.includes(value), value);
  assert.ok(getEncoding('o200k_base').encode(facts).length <= 310, facts);
  const partial = structuredClone(claude);
  partial.state = 'fresh';
  const resetFacts = routingSelectionFacts({
    resolution: {
      state: 'fresh',
      snapshot: {
        candidates: [
          {
            binding: { catId: 'fable-5', capacityFacts: { current: partial, switchRequired: [] } },
            availability: 'available',
            reasons: [],
          },
        ],
      },
    },
  });
  assert.match(resetFacts, /stale 10%/, 'an account-fresh reading must not hide an elapsed window');
});

test('six-member discovery shows bound and switch-required facts before selection within the agreed budget', async () => {
  const observedAt = Date.parse('2026-10-24T07:00:00Z');
  const current = {
    state: 'fresh',
    accountLabel: '主号',
    plan: 'plus',
    bindingRevision: 'opaque-binding',
    evidenceRef: 'opaque-capacity',
    observedAt,
    validUntil: observedAt + 600000,
    windows: [
      {
        poolId: 'opaque-main',
        poolKind: 'codex-main',
        applicability: 'unknown',
        freshness: 'fresh',
        kind: 'five_hour',
        remainingPercent: 70,
        resetAt: observedAt + 3600000,
      },
      {
        poolId: 'opaque-main',
        poolKind: 'codex-main',
        applicability: 'unknown',
        freshness: 'fresh',
        kind: 'seven_day',
        remainingPercent: 65,
        resetAt: observedAt + 7 * 86400000,
      },
      {
        poolId: 'opaque-spark',
        poolKind: 'codex-spark',
        applicability: 'unknown',
        freshness: 'fresh',
        kind: 'five_hour',
        remainingPercent: 0,
        resetAt: observedAt + 3600000,
      },
      {
        poolId: 'opaque-spark',
        poolKind: 'codex-spark',
        applicability: 'unknown',
        freshness: 'fresh',
        kind: 'seven_day',
        remainingPercent: 0,
        resetAt: observedAt + 7 * 86400000,
      },
      {
        poolId: 'opaque-review',
        poolKind: 'codex-review',
        applicability: 'unknown',
        freshness: 'fresh',
        kind: 'unknown',
        remainingPercent: 0,
        resetAt: observedAt + 7 * 86400000,
      },
      {
        poolId: 'opaque-credits',
        poolKind: 'codex-overflow',
        applicability: 'unknown',
        freshness: 'fresh',
        kind: 'credits',
        remainingAmount: { value: 20, unit: 'credits' },
      },
    ],
  };
  const spare = {
    ...current,
    accountLabel: '备用号',
    evidenceRef: 'opaque-spare',
    windows: current.windows.map((w) => ({
      ...w,
      poolId: `spare-${w.poolId}`,
      ...(w.remainingAmount ? {} : { remainingPercent: 100 }),
    })),
  };
  const spares = [spare];
  const ids = ['codex61-sol', 'codex-sol', 'codex-astra', 'codex6-luna', 'gemini-argon', 'kimi'];
  let readInput;
  const service = new RoutingSelectionService({
    now: () => observedAt,
    readService: {
      readSnapshot: async (input) => {
        readInput = input;
        return {
          resolution: {
            state: 'fresh',
            inputRevisionRef: 'sha256:' + createHash('sha256').update('selection-source-A').digest('hex'),
            snapshot: {
              candidates: ids.map((catId, i) => ({
                binding: {
                  catId,
                  capacityFacts: {
                    v: 1,
                    current: i < 4 ? current : { state: 'unknown', reason: 'binding_unknown', windows: [] },
                    switchRequired: i < 4 ? spares : [],
                  },
                },
                availability: 'available',
                reasons: [],
              })),
            },
          },
        };
      },
    },
  });
  const selection = await service.read({ ownerId: 'owner', role: 'review', targetCatIds: ids });
  assert.deepEqual(readInput.targetCatIds, ids);
  assert.equal(readInput.intent, 'review');
  assert.equal(selection.stage, 'selection');
  assert.match(selection.facts, /applicability unknown/);
  assert.equal(selection.roleFit, 'agent_judgment');
  assert.deepEqual(selection.missingCatIds, []);
  for (const id of ids) assert.ok(selection.facts.includes(id));
  for (const fragment of [
    '70%',
    '65%',
    '100%',
    '需切号才能用',
    'unknown',
    'UTC 2026-10',
    '24T08:00Z',
    '24T07:00Z',
    'spark/5h',
    'review/window?',
    '20 credits',
    'reset unknown',
  ])
    assert.ok(selection.facts.includes(fragment), fragment);
  assert.equal(selection.facts.match(/备用号/g).length, 1, 'shared spare observations do not repeat per member');
  assert.match(
    selection.facts,
    /G1=codex61-sol,codex-sol,codex-astra,codex6-luna:/,
    'spare availability must name the members who need switching',
  );
  assert.match(selection.facts, /需切号才能用\(G1\)/, 'the spare refers to the exact named group');
  const tokens = getEncoding('o200k_base').encode(JSON.stringify(selection)).length;
  assert.ok(tokens <= 320, `six-member selection has ${tokens} approximate tokens`);
  spares.push(
    ...[2, 3].map((n) => ({
      ...structuredClone(spare),
      accountLabel: `备用号${n}`,
      evidenceRef: `opaque-spare-${n}`,
      windows: spare.windows.map((w) => ({ ...w, poolId: `spare-${n}-${w.poolId}` })),
    })),
  );
  const expanded = await service.read({ ownerId: 'owner', role: 'review', targetCatIds: ids });
  for (const label of ['备用号2', '备用号3']) assert.ok(expanded.facts.includes(label));
  assert.equal(expanded.facts.match(/20 credits/g).length, 4, 'each account retains its own credit balance');
  const expandedFactTokens = getEncoding('o200k_base').encode(expanded.facts).length;
  assert.ok(expandedFactTokens <= 330, `four-account fact strip has ${expandedFactTokens} approximate tokens`);
  if (process.env.F293_SELECTION_OUTPUT)
    writeFileSync(
      process.env.F293_SELECTION_OUTPUT,
      JSON.stringify(
        {
          encoding: 'o200k_base',
          tokens,
          selection,
          expandedFourAccounts: {
            factsTokens: expandedFactTokens,
            selectionTokens: getEncoding('o200k_base').encode(JSON.stringify(expanded)).length,
            selection: expanded,
          },
        },
        null,
        2,
      ) + '\n',
    );
});

test('a failed resolver remains unknown and does not silently remove uncovered members', async () => {
  const service = new RoutingSelectionService({
    readService: {
      readSnapshot: async () => ({ resolution: { state: 'degraded', candidateBindings: [{ catId: 'new-member' }] } }),
    },
  });
  const selection = await service.read({
    ownerId: 'owner',
    role: 'implementation',
    targetCatIds: ['new-member', 'uncovered'],
  });
  assert.match(selection.facts, /unknown/);
  assert.deepEqual(selection.missingCatIds, ['uncovered']);
  assert.equal(selection.snapshotRef, undefined);
});

test('a rejected source preserves discovery coverage and exposes no source error text', async () => {
  const service = new RoutingSelectionService({
    readService: {
      readSnapshot: async () => {
        throw new Error('private-account-identity');
      },
    },
  });
  const selection = await service.read({ ownerId: 'owner', role: 'review', targetCatIds: ['first', 'new-member'] });
  assert.match(selection.facts, /unknown/);
  assert.deepEqual(selection.missingCatIds, ['first', 'new-member']);
  assert.ok(!JSON.stringify(selection).includes('private-account-identity'));
});
