import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// F225 A3 propose logic + A4 abuse guard.
describe('proposeSessionHandoff + confirmation card (F225 A3/A4)', () => {
  let proposeSessionHandoff;
  let buildHandoffProposalCardBlock;
  let chainStore;
  let handoffStore;

  beforeEach(async () => {
    const mod = await import('../dist/domains/cats/services/session/sessionHandoffPropose.js');
    proposeSessionHandoff = mod.proposeSessionHandoff;
    buildHandoffProposalCardBlock = mod.buildHandoffProposalCardBlock;
    const chainMod = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    chainStore = new chainMod.SessionChainStore();
    const handoffMod = await import('../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js');
    handoffStore = new handoffMod.InMemorySessionHandoffProposalStore();
  });

  const deps = () => ({ handoffProposalStore: handoffStore, sessionChainStore: chainStore });
  const input = (over = {}) => ({
    sourceCatId: 'opus-45',
    sourceThreadId: 't1',
    userId: 'u1',
    note: { done: 'wrote A3', nextSteps: 'wire MCP tool', commits: ['abc123'] },
    ...over,
  });

  it('creates proposal for current active session; card surfaces 五件套 + gate actions', async () => {
    chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    const res = await proposeSessionHandoff(deps(), input());
    assert.equal(res.ok, true);
    assert.equal(res.proposal.status, 'pending');
    assert.equal(res.proposal.note.done, 'wrote A3');
    // sourceSessionId resolved from getActive, not trusted from caller
    assert.equal(res.proposal.sourceSessionId, chainStore.getActive('opus-45', 't1').id);
    const card = buildHandoffProposalCardBlock(res.proposal);
    assert.equal(card.kind, 'card');
    assert.equal(card.title, '提议 session 接力（封印当前 → 续接 fresh 自己）');
    const cardStr = JSON.stringify(card);
    assert.equal(cardStr.includes(String.fromCodePoint(0x1f504)), false, 'card title does not ship emoji glyphs');
    assert.match(cardStr, /handoff:approve/);
    assert.match(cardStr, /handoff:reject/);
    assert.match(cardStr, /abc123/, 'commits surfaced on card');
    assert.match(cardStr, /wire MCP tool/, 'nextSteps surfaced on card');
  });

  it('no active session → no_active_session', async () => {
    const res = await proposeSessionHandoff(deps(), input());
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_active_session');
  });

  it('A4: second propose for same active session rejected (≤1 pending guard)', async () => {
    chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    await proposeSessionHandoff(deps(), input());
    const res2 = await proposeSessionHandoff(deps(), input());
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, 'already_pending');
  });

  it('A4 cooldown (砚砚 P2): re-propose within window blocked even after pending slot frees', async () => {
    chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    const r1 = await proposeSessionHandoff(deps(), input());
    assert.equal(r1.ok, true);
    handoffStore.markRejected(r1.proposal.proposalId); // pending slot freed
    const r2 = await proposeSessionHandoff(deps(), input()); // immediate → within default 5min cooldown
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'cooldown', 'reject does not bypass cooldown');
  });

  it('A4 cooldown: allowed once cooldown window passes (cooldownMs=0)', async () => {
    chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    const fast = { handoffProposalStore: handoffStore, sessionChainStore: chainStore, cooldownMs: 0 };
    const r1 = await proposeSessionHandoff(fast, input());
    assert.equal(r1.ok, true);
    handoffStore.markRejected(r1.proposal.proposalId);
    const r2 = await proposeSessionHandoff(fast, input()); // cooldownMs=0 → no cooldown
    assert.equal(r2.ok, true, 'no cooldown when window is 0');
  });

  it('A4 hourly cap (砚砚 re-review P2): hourlyLimit/hour allowed, next blocked even with cooldown bypassed', async () => {
    chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    // cooldownMs=0 isolates the hourly cap from the cooldown gate; small hourlyLimit for a fast test.
    const cfg = { handoffProposalStore: handoffStore, sessionChainStore: chainStore, cooldownMs: 0, hourlyLimit: 3 };
    for (let i = 0; i < 3; i++) {
      const r = await proposeSessionHandoff(cfg, input());
      assert.equal(r.ok, true, `proposal ${i + 1}/3 within cap allowed`);
      handoffStore.markRejected(r.proposal.proposalId); // free the ≤1-pending slot for the next try
    }
    const blocked = await proposeSessionHandoff(cfg, input());
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'hourly_limit', '4th within the hour blocked (cooldown=0 → not a cooldown reject)');
  });
});
