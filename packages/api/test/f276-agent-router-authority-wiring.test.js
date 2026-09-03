/**
 * F276/F292 production authority wiring guards.
 *
 * Conditional object spreads bypass TypeScript's excess-property check. Keep
 * the bootstrap constructor surface and AgentRouterOptions aligned, then prove
 * the two disposition authorities reach the invocation boundary unchanged.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

function createMockRegistry() {
  return {
    create: () => ({ invocationId: 'inv-f276-wiring', callbackToken: 'tok-f276-wiring' }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  return {
    append: (message) => ({ ...message, id: 'msg-f276-wiring', threadId: message.threadId ?? 'default' }),
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
  };
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function constructorKeys(source) {
  const keys = new Set();

  function collectObjectLiteral(node) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        collectSpreadExpression(property.expression);
        continue;
      }
      const name = propertyNameText(property.name);
      if (name) keys.add(name);
    }
  }

  function collectSpreadExpression(node) {
    if (ts.isObjectLiteralExpression(node)) {
      collectObjectLiteral(node);
      return;
    }
    ts.forEachChild(node, collectSpreadExpression);
  }

  const candidates = [];
  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'AgentRouter' &&
      node.arguments?.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      candidates.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  assert.equal(candidates.length, 1, 'production bootstrap must have exactly one AgentRouter constructor');
  collectObjectLiteral(candidates[0]);
  return keys;
}

function declaredOptionKeys(source) {
  let optionsInterface;
  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'AgentRouterOptions') optionsInterface = node;
    ts.forEachChild(node, visit);
  }
  visit(source);

  assert.ok(optionsInterface, 'AgentRouterOptions interface must exist');
  return new Set(optionsInterface.members.map((member) => propertyNameText(member.name)).filter(Boolean));
}

describe('F276/F292 AgentRouter authority wiring', () => {
  it('forwards the exact write-opportunity disposition authorities into InvocationDeps', () => {
    const writeOpportunityTerminalLedger = { sentinel: 'terminal-ledger' };
    const writeOpportunityDeliveryStore = { sentinel: 'delivery-store' };
    const router = new AgentRouter({
      agentRegistry: new AgentRegistry(),
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      writeOpportunityTerminalLedger,
      writeOpportunityDeliveryStore,
    });

    const { invocationDeps } = router.getStrategyDeps();
    assert.equal(invocationDeps.writeOpportunityTerminalLedger, writeOpportunityTerminalLedger);
    assert.equal(invocationDeps.writeOpportunityDeliveryStore, writeOpportunityDeliveryStore);
  });

  it('declares every production bootstrap constructor key in AgentRouterOptions', () => {
    const indexPath = new URL('../src/index.ts', import.meta.url);
    const routerPath = new URL('../src/domains/cats/services/agents/routing/AgentRouter.ts', import.meta.url);
    const indexSource = ts.createSourceFile(
      indexPath.pathname,
      readFileSync(indexPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const routerSource = ts.createSourceFile(
      routerPath.pathname,
      readFileSync(routerPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    const declaredKeys = declaredOptionKeys(routerSource);
    const missingKeys = [...constructorKeys(indexSource)].filter((key) => !declaredKeys.has(key)).sort();

    assert.deepEqual(missingKeys, [], 'AgentRouter bootstrap keys must be declared in AgentRouterOptions');
  });

  it('forwards queue-owned memory carriers through routeExecution', () => {
    const source = readFileSync(
      new URL('../src/domains/cats/services/agents/routing/AgentRouter.ts', import.meta.url),
      'utf8',
    );

    assert.ok(
      source.includes('memoryCueOpportunitySeeds: options?.memoryCueOpportunitySeeds'),
      'memory cue seeds must survive routeExecution option assembly',
    );
    assert.ok(
      source.includes('asrPersonMemoryScenes: options?.asrPersonMemoryScenes'),
      'ASR person-memory scenes must survive routeExecution option assembly',
    );
  });
});
