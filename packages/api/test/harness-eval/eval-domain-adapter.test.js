import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { EvalDomainAdapter } from '../../dist/infrastructure/harness-eval/friction/eval-domain-adapter.js';

// F245 Phase B Task 5 — EvalDomainAdapter（eval 域 friction_counts → FrictionSignal）
// Fixture 用真实 snapshot.json schema（对齐 eval-a2a-artifact-resolver bundleSnapshotSchema）：
// 若 adapter 提取错字段，测试会红（避免 confound：fixture 是真 schema，不是迁就 adapter 假设）。

const WINDOW_START = Date.parse('2026-06-19T00:00:00.000Z');
const WINDOW_END = Date.parse('2026-06-20T00:00:00.000Z');
const IN_WINDOW = '2026-06-19T10:00:00.000Z';
const BEFORE_WINDOW = '2026-06-18T10:00:00.000Z';

function realSnapshot(over = {}) {
  return {
    verdictId: 'v1',
    evalSnapshotId: 'snap-1',
    featureId: 'F245',
    generatedAt: IN_WINDOW,
    window: { durationHours: 72 },
    components: [
      {
        componentId: 'C1',
        componentName: 'rg noise',
        activationCounts: { runs: 10 },
        frictionCounts: { rg_noise_count: 3, clean_count: 0, missing: null },
        confidence: 'medium',
      },
    ],
    ...over,
  };
}

describe('EvalDomainAdapter (F245 Phase B Task 5)', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'f245-eval-domain-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function freshAdapter() {
    // each test gets its own bundles subtree via unique verdictId dirs; clean between by new root
    const sub = mkdtempSync(join(tmpdir(), 'f245-eval-domain-case-'));
    return { adapter: new EvalDomainAdapter(sub), sub };
  }

  it('channelId is "eval-domain"', () => {
    assert.equal(new EvalDomainAdapter(root).channelId, 'eval-domain');
  });

  it('lists non-zero non-null frictionCounts as signals with correct fields', async () => {
    const { adapter, sub } = freshAdapter();
    const dir = join(sub, 'bundles', 'v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(realSnapshot()));

    const signals = await adapter.pull(WINDOW_START, WINDOW_END);
    rmSync(sub, { recursive: true, force: true });

    assert.equal(signals.length, 1, '只 rg_noise_count=3；clean_count=0 与 missing=null 跳过');
    const s = signals[0];
    assert.equal(s.id, 'eval-domain:v1#C1#rg_noise_count');
    assert.equal(s.channel, 'eval-domain');
    assert.equal(s.tool, 'C1', 'tool = componentId');
    assert.equal(s.symptom, 'rg_noise_count=3');
    assert.equal(s.rawRef, 'v1#C1#rg_noise_count');
    assert.equal(s.severity, 'low', '聚合 proxy → low');
    assert.equal(s.timestamp, IN_WINDOW, 'timestamp = snapshot.generatedAt');
    assert.equal(s.sourceEvidence, 'rg noise: rg_noise_count=3');
    assert.equal(s.catId, undefined);
    assert.equal(s.threadId, undefined);
  });

  it('counts multiple components × multiple non-zero metrics', async () => {
    const { adapter, sub } = freshAdapter();
    const dir = join(sub, 'bundles', 'v2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'snapshot.json'),
      JSON.stringify(
        realSnapshot({
          verdictId: 'v2',
          components: [
            { componentId: 'C1', componentName: 'a', frictionCounts: { m1: 1, m2: 2 } },
            { componentId: 'C2', componentName: 'b', frictionCounts: { m3: 3, zero: 0 } },
          ],
        }),
      ),
    );

    const signals = await adapter.pull(WINDOW_START, WINDOW_END);
    rmSync(sub, { recursive: true, force: true });
    assert.equal(signals.length, 3, 'C1{m1,m2} + C2{m3}（zero 跳过）');
    assert.deepEqual(signals.map((s) => s.id).sort(), [
      'eval-domain:v2#C1#m1',
      'eval-domain:v2#C1#m2',
      'eval-domain:v2#C2#m3',
    ]);
  });

  it('supports id/name component aliases (real schema fallback)', async () => {
    const { adapter, sub } = freshAdapter();
    const dir = join(sub, 'bundles', 'v3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'snapshot.json'),
      JSON.stringify(
        realSnapshot({ verdictId: 'v3', components: [{ id: 'CX', name: 'aliased', frictionCounts: { z: 7 } }] }),
      ),
    );

    const signals = await adapter.pull(WINDOW_START, WINDOW_END);
    rmSync(sub, { recursive: true, force: true });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].id, 'eval-domain:v3#CX#z');
    assert.equal(signals[0].sourceEvidence, 'aliased: z=7');
  });

  it('filters snapshots by generatedAt (half-open window)', async () => {
    const { adapter, sub } = freshAdapter();
    const inDir = join(sub, 'bundles', 'vin');
    const outDir = join(sub, 'bundles', 'vout');
    mkdirSync(inDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(inDir, 'snapshot.json'),
      JSON.stringify(realSnapshot({ verdictId: 'vin', generatedAt: IN_WINDOW })),
    );
    writeFileSync(
      join(outDir, 'snapshot.json'),
      JSON.stringify(realSnapshot({ verdictId: 'vout', generatedAt: BEFORE_WINDOW })),
    );

    const signals = await adapter.pull(WINDOW_START, WINDOW_END);
    rmSync(sub, { recursive: true, force: true });
    assert.equal(signals.length, 1, '只窗内 snapshot');
    assert.ok(signals[0].id.startsWith('eval-domain:vin#'));
  });

  it('idempotent: same bundles → identical id set across pulls', async () => {
    const { adapter, sub } = freshAdapter();
    const dir = join(sub, 'bundles', 'v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(realSnapshot()));

    const first = (await adapter.pull(WINDOW_START, WINDOW_END)).map((s) => s.id).sort();
    const second = (await adapter.pull(WINDOW_START, WINDOW_END)).map((s) => s.id).sort();
    rmSync(sub, { recursive: true, force: true });
    assert.deepEqual(second, first);
  });

  it('skips malformed snapshot.json without crashing; missing bundles dir → []', async () => {
    const { adapter, sub } = freshAdapter();
    const dir = join(sub, 'bundles', 'vbad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.json'), '{ not valid json');
    const got = await adapter.pull(WINDOW_START, WINDOW_END);
    rmSync(sub, { recursive: true, force: true });
    assert.deepEqual(got, [], 'malformed 跳过');

    const empty = new EvalDomainAdapter(join(tmpdir(), 'f245-nonexistent-xyz'));
    assert.deepEqual(await empty.pull(WINDOW_START, WINDOW_END), [], '无 bundles 目录 → []');
  });

  it('R1 self-exclusion: excludeFeatureIds drops self-produced bundles (friction 不吃自己产出)', async () => {
    const sub = mkdtempSync(join(tmpdir(), 'f245-eval-domain-exclude-'));
    // friction 自己产出的 bundle（featureId='F245'，含 cluster_count/cluster_<id>）
    const selfDir = join(sub, 'bundles', 'friction-self');
    mkdirSync(selfDir, { recursive: true });
    writeFileSync(
      join(selfDir, 'snapshot.json'),
      JSON.stringify(
        realSnapshot({
          verdictId: 'friction-self',
          featureId: 'F245',
          components: [
            { id: 'friction-rollup', name: 'Friction Rollup', frictionCounts: { cluster_count: 5, cluster_abc: 3 } },
          ],
        }),
      ),
    );
    // 别的 domain 产出的 bundle（featureId='F192'）→ 应保留（friction 只吃别的 domain）
    const otherDir = join(sub, 'bundles', 'other-domain');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, 'snapshot.json'),
      JSON.stringify(
        realSnapshot({
          verdictId: 'other-domain',
          featureId: 'F192',
          components: [{ id: 'CX', name: 'other', frictionCounts: { other_count: 4 } }],
        }),
      ),
    );

    // baseline（无排除）：吃两个 bundle，含 friction 自己 = 自回授（@gpt52 复现的 bug 行为）
    const noExclude = await new EvalDomainAdapter(sub).pull(WINDOW_START, WINDOW_END);
    assert.equal(
      noExclude.length,
      3,
      'baseline: F245{cluster_count,cluster_abc}=2 + F192{other_count}=1；无排除时吃自己',
    );

    // 修复（排除 F245）：friction 不吃自己，只剩别的 domain
    const excluded = await new EvalDomainAdapter(sub, { excludeFeatureIds: new Set(['F245']) }).pull(
      WINDOW_START,
      WINDOW_END,
    );
    rmSync(sub, { recursive: true, force: true });
    assert.equal(excluded.length, 1, 'self-exclusion: friction 自产 bundle 全跳过，只剩 F192');
    assert.equal(excluded[0].id, 'eval-domain:other-domain#CX#other_count');
    assert.ok(
      excluded.every((s) => !s.symptom.startsWith('cluster_')),
      'friction 自产 frictionCounts（cluster_*）不得回流为 eval-domain signal',
    );
  });
});
