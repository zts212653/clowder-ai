/**
 * F296 B3b-1 production composition guard.
 *
 * Direct invokeSingleCat fixtures can prove ordering while still missing the
 * production AgentRouter supply chain. These assertions make that optional-DI
 * failure mode visible: the exact owner constructed by composition must reach
 * InvocationDeps, and index.ts must select the shared Redis store when Redis is
 * available.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

function createMockRegistry() {
  return {
    create: () => ({ invocationId: 'inv-f296-wiring', callbackToken: 'tok-f296-wiring' }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  return {
    append: (message) => ({ ...message, id: 'msg-f296-wiring', threadId: message.threadId ?? 'default' }),
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
  };
}

describe('F296 B3b production context infrastructure wiring', () => {
  it('AgentRouter forwards the exact configured owner, hook readiness coordinates, and ledger into InvocationDeps', () => {
    const contextEpochOwner = { resolve: async () => assert.fail('wiring test must not resolve') };
    const presentationLedger = { reserve: async () => assert.fail('wiring test must not reserve') };
    const claudeProjectHookCarrierReady = () => true;
    const router = new AgentRouter({
      agentRegistry: new AgentRegistry(),
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      contextEpochOwner,
      hookAuthenticationReady: true,
      claudeProjectHookCarrierReady,
      presentationLedger,
    });

    assert.equal(router.getStrategyDeps().invocationDeps.contextEpochOwner, contextEpochOwner);
    assert.equal(router.getStrategyDeps().invocationDeps.hookAuthenticationReady, true);
    assert.equal(router.getStrategyDeps().invocationDeps.claudeProjectHookCarrierReady, claudeProjectHookCarrierReady);
    assert.equal(router.getStrategyDeps().invocationDeps.presentationLedger, presentationLedger);
  });

  it('production composition chooses Redis persistence and supplies the owner to AgentRouter', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    assert.match(source, /new ContextEpochOwner\(new RedisContextEpochStore\(redis\)\)/);
    assert.match(
      source,
      /^\s*contextEpochOwner,\s*$/m,
      'the constructed owner must be passed into AgentRouter rather than remaining dead composition code',
    );
    assert.match(
      source,
      /hookAuthenticationReady:\s*sessionHookAuthenticationReady/,
      'the live invocation-auth readiness resolver must reach provider-bound invocation deps',
    );
    assert.match(
      source,
      /claudeProjectHookCarrierReady:\s*isClaudeProjectHookCarrierReady/,
      'the active-workspace carrier resolver must reach provider-bound invocation deps',
    );
    assert.match(source, /new PresentationLedger\(new RedisPresentationLedgerStore\(redis\)\)/);
    assert.match(
      source,
      /new InMemoryPresentationLedgerStore\(contextEpochStore\)/,
      'the no-Redis fallback must share the same epoch owner so its write fence cannot diverge',
    );
    assert.match(
      source,
      /^\s*presentationLedger,\s*$/m,
      'the constructed presentation ledger must reach AgentRouter rather than remaining dead composition code',
    );
  });
});
