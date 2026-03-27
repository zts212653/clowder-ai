import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('ActorResolver', () => {
  /**
   * Mock roster for tests — matches structure from cat-config-loader.getRoster()
   * opus: lead architect, available
   * codex: peer-reviewer + coder, available
   * gemini: visual-designer, available
   * sonnet: architect, NOT available (no quota)
   */
  const mockRoster = {
    opus: { family: 'claude', roles: ['architect', 'coder'], lead: true, available: true, evaluation: 'strong' },
    codex: { family: 'openai', roles: ['peer-reviewer', 'coder'], lead: false, available: true, evaluation: 'strong' },
    gemini: { family: 'google', roles: ['visual-designer'], lead: false, available: true, evaluation: 'strong' },
    sonnet: { family: 'claude', roles: ['architect'], lead: false, available: false, evaluation: 'strong' },
  };

  it('resolves repo-watcher to available cat with peer-reviewer role', async () => {
    const { createActorResolver } = await import('../../dist/infrastructure/scheduler/ActorResolver.js');
    const resolve = createActorResolver(() => mockRoster);
    const catId = resolve('repo-watcher', 'cheap');
    assert.equal(catId, 'codex'); // codex has peer-reviewer role
  });

  it('costTier deep prefers lead cat', async () => {
    const { createActorResolver } = await import('../../dist/infrastructure/scheduler/ActorResolver.js');
    const resolve = createActorResolver(() => mockRoster);
    // memory-curator maps to architect → opus (lead) and sonnet (unavailable)
    const catId = resolve('memory-curator', 'deep');
    assert.equal(catId, 'opus'); // opus is lead + available
  });

  it('costTier cheap prefers non-lead cat', async () => {
    const { createActorResolver } = await import('../../dist/infrastructure/scheduler/ActorResolver.js');
    // Add a non-lead architect that is available
    const rosterWithNonLead = {
      ...mockRoster,
      sonnet: { ...mockRoster.sonnet, available: true }, // make sonnet available
    };
    const resolve = createActorResolver(() => rosterWithNonLead);
    const catId = resolve('memory-curator', 'cheap');
    assert.equal(catId, 'sonnet'); // sonnet is non-lead architect
  });

  it('returns null when no cat matches role', async () => {
    const { createActorResolver } = await import('../../dist/infrastructure/scheduler/ActorResolver.js');
    // gemini has visual-designer which maps to nothing in actor roles
    const resolve = createActorResolver(() => ({ gemini: mockRoster.gemini }));
    const catId = resolve('repo-watcher', 'cheap');
    assert.equal(catId, null);
  });

  it('skips unavailable cats', async () => {
    const { createActorResolver } = await import('../../dist/infrastructure/scheduler/ActorResolver.js');
    // Only sonnet has architect role, but is unavailable
    const resolve = createActorResolver(() => ({
      sonnet: mockRoster.sonnet, // unavailable
      gemini: mockRoster.gemini, // available but wrong role
    }));
    const catId = resolve('memory-curator', 'deep');
    assert.equal(catId, null);
  });

  it('health-monitor maps to architect or peer-reviewer', async () => {
    const { createActorResolver } = await import('../../dist/infrastructure/scheduler/ActorResolver.js');
    const resolve = createActorResolver(() => mockRoster);
    const catId = resolve('health-monitor', 'cheap');
    // codex (peer-reviewer, non-lead) should be preferred over opus (architect, lead) for cheap
    assert.equal(catId, 'codex');
  });
});
