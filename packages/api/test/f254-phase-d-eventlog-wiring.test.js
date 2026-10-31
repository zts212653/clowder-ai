/**
 * F254 Phase D (AC-D4): freshnessEventLog wiring guard.
 *
 * Regression context: intake #2816 (clowder-ai#1075) overwrote routing files with the
 * sanitized community version, severing the freshnessEventLog supply chain. PR #2822
 * restored the *consumer* (route-serial `deps.freshnessEventLog`) and the *declaration*
 * (RouteStrategyDeps) but not the *producer* (index.ts construction + AgentRouter
 * forwarding). Because the field is optional and every consumer guards on truthiness,
 * `tsc --noEmit` stayed green while the audit log silently never recorded.
 *
 * These tests assert the wiring itself, which the existing f254-*.test.js suites cannot
 * catch: they hand-build `deps` and call routeSerial directly, bypassing AgentRouter.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

function createMockRegistry() {
  let counter = 0;
  return {
    create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  return {
    append: (msg) => ({ ...msg, id: 'msg-000001', threadId: msg.threadId ?? 'default' }),
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
  };
}

function createMockThreadStore() {
  return {
    get: () => null,
    getParticipants: () => [],
    addParticipants: () => {},
    updateLastActive: () => {},
  };
}

describe('F254 Phase D (AC-D4): freshnessEventLog wiring', () => {
  it('AgentRouter forwards freshnessEventLog into RouteStrategyDeps', () => {
    const sentinel = { append: async () => {} };

    const router = new AgentRouter({
      agentRegistry: new AgentRegistry(),
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      threadStore: createMockThreadStore(),
      freshnessEventLog: sentinel,
    });

    const deps = router.getStrategyDeps();

    assert.equal(
      deps.freshnessEventLog,
      sentinel,
      'route-serial consumes `deps.freshnessEventLog`; AgentRouter must forward it or the audit log is dead code',
    );
  });

  it('AgentRouter omits freshnessEventLog when none supplied (no undefined key leak)', () => {
    const router = new AgentRouter({
      agentRegistry: new AgentRegistry(),
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      threadStore: createMockThreadStore(),
    });

    assert.equal(router.getStrategyDeps().freshnessEventLog, undefined);
  });

  it('index.ts constructs FreshnessAttentionEventLog and supplies both consumers', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    assert.match(
      src,
      /new FreshnessAttentionEventLog\(/,
      'index.ts must construct FreshnessAttentionEventLog — without it both AgentRouter and QueueProcessor starve',
    );
    assert.match(
      src,
      /\.\.\.\(freshnessEventLog \? \{ freshnessEventLog \} : \{\}\)/,
      'index.ts must pass freshnessEventLog into AgentRouter options',
    );
    assert.match(
      src,
      /^\s*freshnessEventLog,\s*$/m,
      'index.ts must pass freshnessEventLog into QueueProcessor options (QueueProcessor.deps.freshnessEventLog)',
    );
  });
});
