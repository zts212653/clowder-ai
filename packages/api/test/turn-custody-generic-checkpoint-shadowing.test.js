/**
 * F167/F257 — a route-owned exact custody contract shadows the generic checkpoint.
 *
 * D22 is a per-turn checklist that enumerates every custody exit. When the route
 * has already emitted an exact F167 protocol contract for the turn (structured
 * hold / dispatch), that contract narrows the legal exits — a managed-hold wake
 * cannot use `returnToPredecessor` at all — and D22 would put the excluded exits
 * straight back in front of the cat. The exact contract therefore shadows D22
 * for that turn.
 *
 * Two things must hold, and the second is the one that is easy to get wrong:
 *
 *  - the shadow is scoped to the exact turn, so an ordinary turn still gets D22;
 *  - the shadow happens IN the pipeline and is recorded as a skipped trace event.
 *    Filtering D22 out of the rendered text alone would leave the trace claiming
 *    it fired, and the evaluation ledger would then be measuring a segment that
 *    never reached the model.
 *
 * Scope, stated so the next reader does not over-trust this file: these cases
 * pin the PIPELINE half of the contract — that a named hook is skipped, that the
 * route's reason reaches the trace verbatim, and that nothing else is caught in
 * the blast radius. They pass even if the route never asks for suppression. The
 * ROUTE half — that a structured hold/dispatch turn actually names D22 — is
 * falsified by turn-custody-stop-gate-route.test.js, which goes red the moment
 * the route wiring is removed.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

const SHADOWED_HOOK_ID = 'D22';
const SUPPRESSION_REASON = 'shadowed_by_exact_turn_custody_protocol';

describe('exact turn-custody contract shadows the generic D22 checkpoint', () => {
  let pipelineMod;
  let bridgeMod;
  let hookRegistry;
  let resolversMod;
  let templateMod;

  before(async () => {
    const [pm, rm, rsm, tm, bm, shared] = await Promise.all([
      import('../dist/domains/prompt-hooks/HookPipeline.js'),
      import('../dist/domains/prompt-hooks/HookRegistry.js'),
      import('../dist/domains/prompt-hooks/resolvers/index.js'),
      import('../dist/domains/cats/services/context/prompt-template-loader.js'),
      import('../dist/domains/prompt-hooks/assemble-bridge.js'),
      import('@cat-cafe/shared'),
    ]);
    pipelineMod = pm;
    resolversMod = rsm;
    templateMod = tm;
    bridgeMod = bm;

    const catReg = shared.catRegistry;
    catReg.reset();
    catReg.register('opus', {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师和核心开发者',
      personality: '温柔但有主见',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@opus'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    });
    catReg.register('codex', {
      displayName: '缅因猫',
      nickname: '砚砚',
      name: 'Maine Coon',
      roleDescription: 'Review、找 bug',
      personality: '严谨',
      defaultModel: 'gpt-5.5',
      mentionPatterns: ['@codex'],
      restrictions: [],
      clientId: 'openai',
      breedId: 'maine-coon',
    });

    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    const root = findMonorepoRoot();
    hookRegistry = new rm.HookRegistry(join(root, 'assets', 'prompt-hooks'), join(root, 'assets', 'prompt-templates'));
    hookRegistry.scan();
  });

  function runTurn(extraContext) {
    const input = bridgeMod.assembleForTurn({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
      threadId: 'thread-shadow-probe',
      ...extraContext,
    });
    const pipeline = new pipelineMod.HookPipeline(hookRegistry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const result = pipeline.executeStage('per-turn', input);
    return {
      event: result.events.find((event) => event.hookId === SHADOWED_HOOK_ID),
      patch: result.patches.find((patch) => patch.hookId === SHADOWED_HOOK_ID),
    };
  }

  it('an ordinary turn still injects the generic checkpoint', () => {
    const { event, patch } = runTurn({});
    assert.ok(event, 'D22 must be present in the per-turn trace');
    assert.equal(event.status, 'fired', 'an ordinary turn has no exact contract to shadow D22');
    assert.ok(patch, 'the ordinary turn renders D22 content');
  });

  it('an exact contract skips the checkpoint and says so in the trace', () => {
    const { event, patch } = runTurn({
      suppressedHookIds: [SHADOWED_HOOK_ID],
      hookSuppressionReason: SUPPRESSION_REASON,
    });
    assert.ok(event, 'the shadowed hook must still appear in the trace');
    assert.equal(event.status, 'skipped', 'the ledger must not claim a shadowed hook fired');
    assert.equal(event.reasonCode, 'route_suppressed');
    assert.equal(event.reason, SUPPRESSION_REASON, 'the route-supplied reason reaches the trace verbatim');
    assert.equal(patch, undefined, 'no D22 content reaches the assembled prompt');
  });

  it('shadowing is scoped to the named hook only', () => {
    const input = bridgeMod.assembleForTurn({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
      threadId: 'thread-shadow-probe',
      suppressedHookIds: [SHADOWED_HOOK_ID],
      hookSuppressionReason: SUPPRESSION_REASON,
    });
    const pipeline = new pipelineMod.HookPipeline(hookRegistry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const result = pipeline.executeStage('per-turn', input);
    const otherSuppressed = result.events.filter(
      (event) => event.hookId !== SHADOWED_HOOK_ID && event.reasonCode === 'route_suppressed',
    );
    assert.deepEqual(
      otherSuppressed.map((event) => event.hookId),
      [],
      'only the hook the route named may be shadowed — D21 and the rest keep firing',
    );
  });
});
