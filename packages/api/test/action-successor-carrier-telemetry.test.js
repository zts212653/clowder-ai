import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const instruments = await import('../dist/infrastructure/telemetry/instruments.js');
const multiMentionRoutes = await import('../dist/routes/callback-multi-mention-routes.js');

describe('action successor carrier migration telemetry', () => {
  it('exports and warms the bounded carrier counters', () => {
    for (const name of [
      'successorMultiMentionTotal',
      'successorSingleTargetMultiMention',
      'successorUnfencedSingleTargetMultiMention',
      'successorActionFenceUnavailable',
      'successorAgentKeyActionRejected',
      'protocolActionWithoutCustodyTotal',
      'userNudgeRequiredTotal',
      'legacyGuardWithoutActiveCustodyTotal',
      'sameSubjectPostTerminalEnqueueTotal',
      'leaseSucceededSubjectNonterminalTotal',
      'unresolvedSubjectWithoutActiveCustodyTotal',
      'returnDeliveryOverdueTotal',
      'managedCommandCompletionUnconsumedTotal',
      'managedCommandDispatchRetryTotal',
      'managedCommandWakeSlaBreachTotal',
      'userPingBeforeHolderTerminalTotal',
    ]) {
      assert.equal(typeof instruments[name]?.add, 'function', `${name} must be an incrementable counter`);
    }
    assert.doesNotThrow(() => instruments.warmupCounters());
  });

  it('records reconciliation events at the state transitions that create them', () => {
    const source = readFileSync(
      new URL('../src/domains/cats/services/agents/invocation/QueueProcessor.ts', import.meta.url),
      'utf8',
    );
    assert.match(
      source,
      /committed\.lease\?\.status === 'replaceable'[\s\S]*unresolvedSubjectWithoutActiveCustodyTotal\.add\(1\)/,
    );
    assert.match(
      source,
      /if \(committed\.outcome === 'recorded'\) \{\s*leaseSucceededSubjectNonterminalTotal\.add\(1\)/,
    );
  });

  it('counts a structured action with no admission service in the Phase T denominator', () => {
    for (const route of ['callbacks.ts', 'callback-multi-mention-routes.ts']) {
      const source = readFileSync(new URL(`../src/routes/${route}`, import.meta.url), 'utf8');
      assert.match(source, /successorActionFenceUnavailable\.add\(1\);\s*protocolActionWithoutCustodyTotal\.add\(1\)/);
    }
  });

  it('classifies legacy unfenced single-target calls without treating parallel calls as friction', () => {
    assert.deepEqual(multiMentionRoutes.classifyMultiMentionCarrierUsage({ targetCount: 1, hasAction: false }), {
      singleTarget: true,
      unfencedSingleTarget: true,
    });
    assert.deepEqual(multiMentionRoutes.classifyMultiMentionCarrierUsage({ targetCount: 1, hasAction: true }), {
      singleTarget: true,
      unfencedSingleTarget: false,
    });
    assert.deepEqual(multiMentionRoutes.classifyMultiMentionCarrierUsage({ targetCount: 2, hasAction: true }), {
      singleTarget: false,
      unfencedSingleTarget: false,
    });
  });

  it('does not count expected agent-key rejection as runtime fence unavailability', () => {
    const source = readFileSync(new URL('../src/routes/callbacks.ts', import.meta.url), 'utf8');
    const agentKeyStart = source.indexOf("if (principal.kind === 'agent_key')");
    const agentKeyEnd = source.indexOf('const threadResult = await resolvePrincipalThread', agentKeyStart);
    assert.notEqual(agentKeyStart, -1);
    assert.notEqual(agentKeyEnd, -1);
    const agentKeyValidation = source.slice(agentKeyStart, agentKeyEnd);

    assert.match(agentKeyValidation, /successorAgentKeyActionRejected\.add\(1\)/);
    assert.doesNotMatch(agentKeyValidation, /successorActionFenceUnavailable\.add\(1\)/);
  });
});
