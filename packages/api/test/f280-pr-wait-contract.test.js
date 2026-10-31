import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const PROPOSAL_ROUTES_SOURCE = readFileSync(new URL('../src/routes/proposal-routes.ts', import.meta.url), 'utf8');
const PROPOSE_THREAD_ROUTE_SOURCE = readFileSync(
  new URL('../src/routes/callback-propose-thread-routes.ts', import.meta.url),
  'utf8',
);

const PROPOSAL_GATE_PATH = new URL('../src/routes/proposal-community-pr-gate.ts', import.meta.url);
const PROPOSAL_TRANSITION_PATH = new URL('../src/routes/proposal-community-pr-transition.ts', import.meta.url);

describe('F280 PR wait cutover guards', () => {
  it('formal community review approval never promises or creates automatic PR tracking', () => {
    assert.equal(existsSync(PROPOSAL_GATE_PATH), false, 'proposal-community-pr-gate.ts must be deleted');
    assert.equal(existsSync(PROPOSAL_TRANSITION_PATH), false, 'proposal-community-pr-transition.ts must be deleted');

    const source = `${PROPOSAL_ROUTES_SOURCE}\n${PROPOSE_THREAD_ROUTE_SOURCE}`;
    for (const forbidden of [
      'intent=review',
      'intent=merge',
      'wakePolicy',
      'eventWait',
      'human_participant_activity',
      "kind: 'pr_tracking'",
      'communityPrContext',
    ]) {
      assert.equal(source.includes(forbidden), false, `proposal flow still contains ${forbidden}`);
    }
  });

  it('TaskStore exposes complete replacement CAS instead of relying on deep patch deletion', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    assert.equal(typeof store.replaceAutomationStateIfGeneration, 'function');
  });
});
