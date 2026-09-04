import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('F311 Phase 4 production owner composition', () => {
  it('registers the late-bound F311 consumer before F313 resolves owner bindings', async () => {
    const [source, registrationSource] = await Promise.all([
      readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
      readFile(
        new URL(
          '../src/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-runtime-registration.ts',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    const ownerHolder = source.indexOf('let evolutionChangeOwner: EvolutionChangeOwnerPort | undefined;');
    const consumerRegistration = source.indexOf('registerF311E0EvalRepairOwnerRuntime({');
    const ownerRuntimeCreation = source.indexOf('await createEvalRepairOwnerRuntime({');

    assert.ok(ownerHolder >= 0, 'production bootstrap must retain a refs-only late-bound owner holder');
    assert.ok(consumerRegistration > ownerHolder, 'F311 must register only after its late-bound holder exists');
    assert.ok(
      ownerRuntimeCreation > consumerRegistration,
      'F311 must register before F313 takes the atomic owner-binding snapshot',
    );
    assert.match(
      source.slice(consumerRegistration, ownerRuntimeCreation),
      /connectEvolutionOwner\(owner\) \{\s*evolutionChangeOwner = owner;\s*\}/,
    );
    assert.equal(
      registrationSource.match(/registration\.registerEvolutionOwnerConsumer\(/g)?.length,
      1,
      'production bootstrap must expose exactly one F311 owner consumer',
    );
  });
});
