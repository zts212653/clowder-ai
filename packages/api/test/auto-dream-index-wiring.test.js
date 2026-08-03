import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('F255 production bootstrap wiring', () => {
  it('routes CAT_CAFE_DATA_DIR into the memory-owned data root', () => {
    assert.match(
      source,
      /markersDir,\n\s+dataDir: process\.env\.CAT_CAFE_DATA_DIR,\n\s+transcriptDataDir,/,
      'worktree data-root overrides must reach createMemoryServices instead of falling back to ~/.cat-cafe',
    );
  });

  it('binds every private memory surface to one normalized startup owner', () => {
    assert.match(source, /const privateUserId = \(process\.env\.CAT_CAFE_USER_ID \?\? 'default-user'\)\.trim\(\);/);
    assert.match(source, /await app\.register\(sessionRoute, \{ ownerUserId: privateUserId \}\);/);
    assert.match(source, /privateUserId,\n\s+\/\/ Phase E-2/);
    assert.match(source, /messageStore\.getByThread\(threadId, limit \?\? 2000, privateUserId\)/);
    assert.match(source, /privateOwnerUserId: privateUserId/);
  });

  it('boots F255 after scheduler ports exist and before Schedule exposes the template catalog', () => {
    const templateRegistry = source.indexOf(
      "const { templateRegistry } = await import('./infrastructure/scheduler/templates/registry.js');",
    );
    const bootstrap = source.indexOf('await bootstrapAutoDream({');
    const scheduleRoutes = source.indexOf("const { scheduleRoutes } = await import('./routes/schedule.js');");

    assert.notEqual(templateRegistry, -1, 'template registry construction must remain discoverable');
    assert.notEqual(bootstrap, -1, 'F255 bootstrap must be called from production index.ts');
    assert.notEqual(scheduleRoutes, -1, 'schedule route registration must remain discoverable');
    assert.ok(templateRegistry < bootstrap, 'F255 needs the live template registry before bootstrap');
    assert.ok(bootstrap < scheduleRoutes, 'Schedule must not snapshot the catalog before F255 registers its template');

    const wiring = source.slice(bootstrap, scheduleRoutes);
    for (const requiredPort of [
      'dataDir: memoryServices.dataDir',
      'ownerUserId: privateUserId',
      'catalog: memoryServices.catalog',
      'collectionStores: memoryServices.collectionStores',
      'registry',
      'agentKeyRegistry',
      'templateRegistry',
      'dynamicTaskStore',
      'taskRunner: taskRunnerV2',
      'threadStore',
      'messageStore',
      'proactiveBroadcaster',
      'awakenedLeaseMs: resolvePresentLoopLeaseMs(process.env.CAT_CAFE_F255_AWAKENED_LEASE_MS)',
    ]) {
      assert.ok(wiring.includes(requiredPort), `F255 production bootstrap is missing ${requiredPort}`);
    }
  });

  it('populates CatRegistry before F255 restores persisted cat-life projections', () => {
    const catalogBootstrap = source.indexOf('const catConfig = bootstrapDefaultCatCatalog();');
    const registryPopulation = source.indexOf('catRegistry.register(id, config);');
    const autoDreamBootstrap = source.indexOf('await bootstrapAutoDream({');

    assert.notEqual(catalogBootstrap, -1, 'production startup must bootstrap the cat catalog');
    assert.notEqual(registryPopulation, -1, 'production startup must populate CatRegistry');
    assert.notEqual(autoDreamBootstrap, -1, 'F255 bootstrap must remain discoverable');
    assert.ok(catalogBootstrap < registryPopulation, 'catalog bootstrap must precede CatRegistry population');
    assert.ok(
      registryPopulation < autoDreamBootstrap,
      'persisted cat-life projections resolve their cat during F255 bootstrap, so CatRegistry must already be populated',
    );
  });

  it('wires F271 reflection after F255 bootstrap through the canonical private-cue sink', () => {
    const bootstrap = source.indexOf('await bootstrapAutoDream({');
    const reflection = source.indexOf('const reflectionProducer = new SessionReflectionProducer({');
    const scheduleRoutes = source.indexOf("const { scheduleRoutes } = await import('./routes/schedule.js');");

    assert.notEqual(bootstrap, -1, 'F255 bootstrap must remain discoverable');
    assert.notEqual(reflection, -1, 'F271 reflection wiring must remain discoverable');
    assert.ok(bootstrap < reflection, 'F271 cannot receive the F255 cue sink before F255 bootstrap completes');
    assert.ok(reflection < scheduleRoutes, 'reflection wiring should stay inside the initialized service graph');

    const wiring = source.slice(reflection, scheduleRoutes);
    assert.ok(
      wiring.includes('cueSink: autoDream.services.store'),
      'F271 production wiring must deliver private cues through the F255-owned canonical sink',
    );
  });

  it('registers the F271 daily producer on F139 with the same reflection ledger and F255 cue sink', () => {
    const reflection = source.indexOf('const reflectionProducer = new SessionReflectionProducer({');
    const daily = source.indexOf('const dailyReflectionProducer = new DailyContextReflectionProducer({');
    const registration = source.indexOf('createDailyContextReflectionTaskSpec({');
    const scheduleRoutes = source.indexOf("const { scheduleRoutes } = await import('./routes/schedule.js');");

    assert.ok(reflection < daily, 'daily reflection must reuse the initialized Phase A producer');
    assert.ok(daily < registration, 'the daily producer must exist before its F139 TaskSpec is registered');
    assert.ok(
      registration < scheduleRoutes,
      'the built-in daily task must be registered before Schedule exposes tasks',
    );

    const wiring = source.slice(reflection, scheduleRoutes);
    for (const requiredPort of [
      'reflectionStore',
      'cueSink: autoDream.services.store',
      'ownerUserId: privateUserId',
      'threadStore',
      'sessionChainStore',
      'reflectionProducer',
      'taskRunnerV2.register(',
    ]) {
      assert.ok(wiring.includes(requiredPort), `F271 daily production wiring is missing ${requiredPort}`);
    }
  });

  it('refuses to hydrate legacy pack delegates to the F255-owned Present Loop', () => {
    const packHydration = source.slice(
      source.indexOf('// F139 Phase 3B: Hydrate pack templates'),
      source.indexOf('// F139 Phase 3A: Hydrate dynamic tasks'),
    );
    const guard = packHydration.indexOf('isF255PresentLoopBuiltinRef(def.builtinTemplateRef)');
    const registration = packHydration.indexOf('templateRegistry.register({');
    assert.notEqual(guard, -1, 'pack hydration must recognize Present Loop delegates');
    assert.ok(guard < registration, 'the F255 delegate guard must run before runtime registration');
  });
});
