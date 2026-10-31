/**
 * targetCats resolver tests (F229 Phase B)
 *
 * Verifies the fail-closed resolution order:
 * 1. Explicit → direct use
 * 2. Thread participants → auto if 1, selection if >1
 * 3. None → selection required
 */

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

async function loadResolver() {
  const { resolveTargetCats } = await import('../dist/domains/concierge/concierge-target-cats-resolver.js');
  return resolveTargetCats;
}

/** Minimal stub deps for tests */
function stubDeps(participants = []) {
  return {
    messageStore: { getByThread: async () => [] },
    threadStore: {
      getParticipants: async () => participants,
    },
  };
}

describe('resolveTargetCats', () => {
  it('returns explicit cats directly', async () => {
    const resolve = await loadResolver();
    const result = await resolve(['codex', 'opus'], 'thread-1', stubDeps());
    assert.deepStrictEqual(result.targetCats, ['codex', 'opus']);
    assert.strictEqual(result.needsSelection, false);
    assert.strictEqual(result.source, 'explicit');
  });

  it('auto-selects when exactly 1 participant', async () => {
    const resolve = await loadResolver();
    const result = await resolve(undefined, 'thread-1', stubDeps(['codex']));
    assert.deepStrictEqual(result.targetCats, ['codex']);
    assert.strictEqual(result.needsSelection, false);
    assert.strictEqual(result.source, 'participant');
  });

  it('requires selection when >1 participants', async () => {
    const resolve = await loadResolver();
    const result = await resolve(undefined, 'thread-1', stubDeps(['codex', 'opus', 'sonnet']));
    assert.deepStrictEqual(result.targetCats, ['codex', 'opus', 'sonnet']);
    assert.strictEqual(result.needsSelection, true);
    assert.strictEqual(result.source, 'ambiguous');
  });

  it('requires selection when 0 participants', async () => {
    const resolve = await loadResolver();
    const result = await resolve(undefined, 'thread-1', stubDeps([]));
    assert.deepStrictEqual(result.targetCats, []);
    assert.strictEqual(result.needsSelection, true);
    assert.strictEqual(result.source, 'none');
  });

  it('requires selection when no threadId', async () => {
    const resolve = await loadResolver();
    const result = await resolve(undefined, undefined, stubDeps());
    assert.deepStrictEqual(result.targetCats, []);
    assert.strictEqual(result.needsSelection, true);
    assert.strictEqual(result.source, 'none');
  });

  it('explicit cats take priority over participants', async () => {
    const resolve = await loadResolver();
    const result = await resolve(['opus'], 'thread-1', stubDeps(['codex', 'sonnet']));
    assert.deepStrictEqual(result.targetCats, ['opus']);
    assert.strictEqual(result.needsSelection, false);
    assert.strictEqual(result.source, 'explicit');
  });

  it('filters out system participant', async () => {
    const resolve = await loadResolver();
    const result = await resolve(undefined, 'thread-1', stubDeps(['system', 'codex']));
    // Should have 1 non-system participant → auto-select
    assert.deepStrictEqual(result.targetCats, ['codex']);
    assert.strictEqual(result.needsSelection, false);
    assert.strictEqual(result.source, 'participant');
  });
});

// ---------------------------------------------------------------------------
// Cloud P2 fix: explicit cats validation against catRegistry
// ---------------------------------------------------------------------------
describe('resolveTargetCats — registry validation (cloud P2)', () => {
  let resolveTargetCats;
  let catRegistry;

  before(async () => {
    const resolverMod = await import('../dist/domains/concierge/concierge-target-cats-resolver.js');
    resolveTargetCats = resolverMod.resolveTargetCats;
    const sharedMod = await import('@cat-cafe/shared');
    catRegistry = sharedMod.catRegistry;
  });

  beforeEach(() => {
    // Clear harness-preloaded cats so each test controls its own registry state.
    // Without this, `catRegistry.register('opus', ...)` throws "already registered"
    // under `pnpm --filter @cat-cafe/api test` which preloads the full cat config.
    catRegistry.reset();
  });

  afterEach(() => {
    catRegistry.reset();
  });

  it('filters out unknown catIds when registry is populated', async () => {
    // Register only 'opus' — 'notacat' is hallucinated
    catRegistry.register('opus', { displayName: 'Opus', clientId: 'anthropic', model: 'claude-opus-4-6' });
    const result = await resolveTargetCats(['opus', 'notacat'], 'thread-1', stubDeps());
    assert.deepStrictEqual(result.targetCats, ['opus']);
    assert.strictEqual(result.needsSelection, false);
    assert.strictEqual(result.source, 'explicit');
  });

  it('falls through when ALL explicit cats are unknown', async () => {
    catRegistry.register('opus', { displayName: 'Opus', clientId: 'anthropic', model: 'claude-opus-4-6' });
    // Both explicit cats are invalid → fall through to participant resolution
    const result = await resolveTargetCats(['notacat', 'fakeid'], 'thread-1', stubDeps(['opus']));
    // Should auto-select from participants since all explicit cats were invalid
    assert.deepStrictEqual(result.targetCats, ['opus']);
    assert.strictEqual(result.source, 'participant');
  });

  it('passes explicit cats through when registry is empty (unit test guard)', async () => {
    // Registry is empty (reset in afterEach) — should pass all through
    const result = await resolveTargetCats(['anything', 'goes'], undefined, stubDeps());
    assert.deepStrictEqual(result.targetCats, ['anything', 'goes']);
    assert.strictEqual(result.needsSelection, false);
    assert.strictEqual(result.source, 'explicit');
  });
});
