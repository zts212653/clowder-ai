import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { createDeferredPersonMemoryDailyTaskSpec } from '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js';
import { createMemoryClerkEligibility } from '../dist/domains/memory/MemoryClerkEligibility.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { createActorResolver } from '../dist/infrastructure/scheduler/ActorResolver.js';
import { RunLedger } from '../dist/infrastructure/scheduler/RunLedger.js';
import { TaskRunnerV2 } from '../dist/infrastructure/scheduler/TaskRunnerV2.js';

function fixture() {
  const registry = new AgentRegistry();
  const configs = new Map();
  const roster = {};
  const register = (id, clientId, provider, carrier, freshnessCarrier) => {
    configs.set(id, { id, clientId });
    registry.register(id, {
      contextCapability: () => ({ provider, carrier }),
      ...(freshnessCarrier ? { freshnessCarrierCapability: () => ({ carrier: freshnessCarrier }) } : {}),
    });
    roster[id] = { available: true, lead: false, roles: ['assistant'], family: 'irrelevant' };
  };
  const eligible = createMemoryClerkEligibility({ agentRegistry: registry, getConfig: (id) => configs.get(id) });
  return { registry, configs, roster, register, eligible };
}

describe('memory clerk execution admission', () => {
  it('reads real native adapter capabilities without starting a turn', async () => {
    const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
    const { AgyNativeAgentService } = await import(
      '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
    );
    const f = fixture();
    f.configs.set('native-codex', { clientId: 'openai' });
    f.configs.set('native-agy', { clientId: 'google' });
    const forbiddenSpawn = () => {
      throw new Error('capability reads must not launch a model');
    };
    f.registry.register(
      'native-codex',
      new CodexAgentService({
        catId: 'codex61-sol',
        model: 'test-model',
        carrierMode: 'app_server',
        spawnFn: forbiddenSpawn,
      }),
    );
    f.registry.register(
      'native-agy',
      new AgyNativeAgentService({ catId: 'agy-opus55', profile: { model: 'test-model' }, spawnCliFn: forbiddenSpawn }),
    );
    assert.equal(f.eligible('native-codex'), true);
    assert.equal(f.eligible('native-agy'), false);
  });

  it('uses actual registered carriers, including AGY native/ACP, OpenCode, unknown and replaced implementations', () => {
    const f = fixture();
    f.register('native', 'google', 'google', 'agy_stream_json', 'agy_stream_json');
    f.register('bridge', 'anthropic', 'anthropic', 'acp', 'agy_acp');
    f.register('open', 'opencode', 'opencode', 'acp', 'other');
    f.register('renamed-member', 'openai', 'codex', 'app_server');
    f.register('background', 'anthropic', 'claude', 'bg');
    f.register('unknown', 'openai', 'unknown', 'unknown');
    for (const id of ['native', 'bridge', 'open', 'unknown', 'missing']) assert.equal(f.eligible(id), false, id);
    assert.equal(f.eligible('renamed-member'), true);
    assert.equal(f.eligible('background'), true);
    f.registry.get('renamed-member').freshnessCarrierCapability = () => ({ carrier: 'agy_acp' });
    assert.equal(f.eligible('renamed-member'), false, 'do not cache a prior carrier choice');
    f.registry.get('background').implementationSnapshot = () => ({ clientId: 'google' });
    assert.equal(f.eligible('background'), false, 'stale config/service pairing is not executable');
  });

  for (const hasEligible of [true, false])
    it(`scheduler ${hasEligible ? 'selects the eligible actor' : 'records a skip without claiming or delivering'}`, async () => {
      const f = fixture();
      f.register('a-strict', 'google', 'google', 'agy_stream_json', 'agy_stream_json');
      if (hasEligible) f.register('b-eligible', 'openai', 'codex', 'app_server');
      f.register('c-unknown', 'openai', 'unknown', 'unknown');
      const db = new Database(':memory:');
      applyMigrations(db);
      const ledger = new RunLedger(db);
      const deliveries = [];
      const claims = [];
      const bindings = [];
      const preflights = [];
      const receipt = {
        state: 'deferred',
        receiptId: `deferred_person_${'a'.repeat(32)}`,
        ownerUserId: 'owner',
        originMessageRef: { kind: 'message', threadId: 'source-thread', messageId: 'source' },
        subject: 'Synthetic Person',
        registryBinding: { kind: 'registered_person', ref: 'person-fixture' },
        sourceCoordinates: [],
      };
      const task = createDeferredPersonMemoryDailyTaskSpec({
        ownerUserId: 'owner',
        isActorEligible: f.eligible,
        ensureSystemThread: async () => 'memory-ops',
        routingDispatchPreflight: {
          async preflight(input) {
            preflights.push(input.targetCatIds);
            return {
              v: 1,
              ownerId: input.ownerId,
              observedAt: Date.now(),
              resolverState: 'fresh',
              targets: input.targetCatIds.map((targetCatId) => ({
                targetCatId,
                disposition: 'allowed',
                reasons: [],
                alternatives: [],
              })),
            };
          },
        },
        receiptStore: {
          async listReady() {
            return [receipt];
          },
          async get() {
            return receipt;
          },
          async claim(input) {
            claims.push(input);
            return {
              outcome: 'claimed',
              receipt: { ...receipt, ...input, state: 'claimed', claimUntil: input.now + input.leaseMs },
            };
          },
          async bindProcessingMessage(input) {
            bindings.push(input);
            return { outcome: 'bound' };
          },
        },
      });
      const runner = new TaskRunnerV2({
        logger: { info() {}, error() {} },
        ledger,
        actorResolver: createActorResolver(() => f.roster, { isScarce: () => false }),
        deliver: async (input) => {
          deliveries.push(input);
          return 'processing-message';
        },
      });
      try {
        runner.register(task);
        await runner.triggerNow(task.id);
        const [row] = ledger.query(task.id, 1);
        assert.equal(row.outcome, hasEligible ? 'RUN_DELIVERED' : 'SKIP_NO_SIGNAL');
        assert.equal(claims.length, hasEligible ? 1 : 0);
        assert.equal(deliveries.length, hasEligible ? 1 : 0);
        assert.equal(receipt.state, 'deferred', 'the read projection itself is not rewritten');
        if (hasEligible) {
          assert.equal(row.assigned_cat_id, 'b-eligible');
          assert.deepEqual(preflights, [['b-eligible']]);
          assert.equal(claims[0].processorCatId, 'b-eligible');
          assert.equal(bindings[0].processingMessageId, 'processing-message');
          assert.equal(deliveries[0].targetCatId, 'b-eligible');
        } else {
          assert.match(row.signal_summary, /no executable actor/);
          assert.deepEqual(preflights, []);
          assert.deepEqual(bindings, []);
        }
      } finally {
        runner.stop();
        db.close();
      }
    });
});
