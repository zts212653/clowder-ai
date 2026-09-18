/**
 * F257 / F231 Phase E: the owner-profile pointer counter must survive the L0 retirement.
 *
 * The retired L0 compiler emitted `cat_cafe.profile.pointer_emitted` per layer. The S14
 * snapshot is the producer now. Nothing asserted the counter after the port, so deleting
 * both `add()` calls left every profile and route test green — this suite closes that.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { metrics } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

const { createMetricAllowlistViews } = await import('../dist/infrastructure/telemetry/metric-allowlist.js');
const metricExporter = new PrometheusExporter({ preventServerStart: true });
const metricProvider = new MeterProvider({ readers: [metricExporter], views: createMetricAllowlistViews() });
metrics.setGlobalMeterProvider(metricProvider);

after(async () => {
  await metricProvider.shutdown();
  metrics.disable();
});

/** Counter value for one layer, or 0 when the series has not been emitted at all. */
async function pointerCount(layer) {
  const { resourceMetrics } = await metricExporter.collect();
  const text = new PrometheusSerializer().serialize(resourceMetrics);
  const line = text
    .split('\n')
    .find((l) => l.startsWith('cat_cafe_profile_pointer_emitted_total{') && l.includes(`profile_layer="${layer}"`));
  return line ? Number(line.trim().split(/\s+/).pop()) : 0;
}

describe('F257 owner profile pointer telemetry', () => {
  let resolveOwnerProfileSnapshot;
  let FileProfileRepository;
  let dataDir;

  const OWNER = 'telemetry-owner';
  const ENV = { CAT_CAFE_USER_ID: OWNER };

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    shared.catRegistry.reset();
    shared.catRegistry.register('opus', {
      displayName: '布偶猫',
      name: 'Ragdoll',
      roleDescription: 'x',
      personality: 'y',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@opus'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
      relationshipKey: 'ragdoll',
    });
    ({ resolveOwnerProfileSnapshot } = await import('../dist/domains/cats/services/profile/owner-profile-snapshot.js'));
    ({ FileProfileRepository } = await import('../dist/domains/cats/services/profile/ProfileRepository.js'));
  });

  const repositoryWith = (t, { primer = false, corpus = false }) => {
    dataDir = mkdtempSync(join(tmpdir(), 'f257-profile-telemetry-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const repository = new FileProfileRepository({ dataDir });
    mkdirSync(repository.profileDir(OWNER), { recursive: true });
    writeFileSync(join(repository.profileDir(OWNER), 'operator-capsule.md'), '主人画像正文');
    if (primer) {
      const p = repository.primerPath(repository.scope(OWNER, 'opus'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '关系正文');
    }
    if (corpus) {
      const c = repository.corpusPath(OWNER);
      mkdirSync(dirname(c), { recursive: true });
      writeFileSync(c, '共享语料');
    }
    return repository;
  };

  it('counts nothing when the owner has a capsule but no pointer layer', async (t) => {
    const before = { primer: await pointerCount('primer'), corpus: await pointerCount('corpus') };

    const snapshot = resolveOwnerProfileSnapshot({
      catId: 'opus',
      repository: repositoryWith(t, {}),
      env: ENV,
    });

    assert.deepEqual(snapshot.pointerLines, [], 'no layer means no pointer');
    assert.equal(await pointerCount('primer'), before.primer, 'primer counter must not move');
    assert.equal(await pointerCount('corpus'), before.corpus, 'corpus counter must not move');
  });

  it('counts exactly one primer emission when the relationship primer exists', async (t) => {
    const before = { primer: await pointerCount('primer'), corpus: await pointerCount('corpus') };

    resolveOwnerProfileSnapshot({ catId: 'opus', repository: repositoryWith(t, { primer: true }), env: ENV });

    assert.equal(await pointerCount('primer'), before.primer + 1, 'primer layer must count once');
    assert.equal(await pointerCount('corpus'), before.corpus, 'corpus layer must not be attributed a primer');
  });

  it('counts exactly one corpus emission when the owner-wide corpus exists', async (t) => {
    const before = { primer: await pointerCount('primer'), corpus: await pointerCount('corpus') };

    resolveOwnerProfileSnapshot({ catId: 'opus', repository: repositoryWith(t, { corpus: true }), env: ENV });

    assert.equal(await pointerCount('corpus'), before.corpus + 1, 'corpus layer must count once');
    assert.equal(await pointerCount('primer'), before.primer, 'primer layer must not be attributed a corpus');
  });

  it('attributes each layer separately when both exist', async (t) => {
    const before = { primer: await pointerCount('primer'), corpus: await pointerCount('corpus') };

    const snapshot = resolveOwnerProfileSnapshot({
      catId: 'opus',
      repository: repositoryWith(t, { primer: true, corpus: true }),
      env: ENV,
    });

    assert.equal(snapshot.pointerLines.length, 2, 'both pointers must be delivered');
    assert.equal(await pointerCount('primer'), before.primer + 1);
    assert.equal(await pointerCount('corpus'), before.corpus + 1);
  });
});
