import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { RoutingSelectionService } from '../dist/domains/routing-context/selection/RoutingSelectionService.js';

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
    '10-24T08:00Z',
    '10-24T07:00Z',
    'spark/5h',
    'review/window?',
    '20 credits',
    'reset unknown',
  ])
    assert.ok(selection.facts.includes(fragment), fragment);
  assert.equal(selection.facts.match(/备用号/g).length, 1, 'shared spare observations do not repeat per member');
  assert.match(
    selection.facts,
    /需切号才能用\(codex61-sol,codex-sol,codex-astra,codex6-luna\)/,
    'spare availability must name the members who need switching',
  );
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
