import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CALLBACK_SOURCE = readFileSync(new URL('../src/routes/callbacks.ts', import.meta.url), 'utf8');
const PROPOSAL_ROUTES_SOURCE = readFileSync(new URL('../src/routes/proposal-routes.ts', import.meta.url), 'utf8');
const PROPOSE_THREAD_ROUTE_SOURCE = readFileSync(
  new URL('../src/routes/callback-propose-thread-routes.ts', import.meta.url),
  'utf8',
);

const PROPOSAL_GATE_PATH = new URL('../src/routes/proposal-community-pr-gate.ts', import.meta.url);
const PROPOSAL_TRANSITION_PATH = new URL('../src/routes/proposal-community-pr-transition.ts', import.meta.url);

describe('F280 PR wait cutover guards', () => {
  it('the callback route exposes only the default-on tracking inputs', () => {
    const start = CALLBACK_SOURCE.indexOf('const registerPrTrackingSchema');
    const end = CALLBACK_SOURCE.indexOf("app.post('/api/callbacks/register-pr-tracking'", start);
    assert.notEqual(start, -1, 'registerPrTrackingSchema must exist');
    assert.notEqual(end, -1, 'register-pr-tracking route must exist');
    const schemaSource = CALLBACK_SOURCE.slice(start, end);

    for (const required of ['repoFullName', 'prNumber', 'include', 'exclude', 'nextStep']) {
      assert.match(schemaSource, new RegExp(`\\b${required}\\b`), `${required} must be in the callback schema`);
    }
    for (const forbidden of [
      'when',
      'expiresAt',
      'autoRenew',
      'intent',
      'wakePolicy',
      'instructions',
      'eventWait',
      'baseline',
    ]) {
      assert.doesNotMatch(schemaSource, new RegExp(`\\b${forbidden}\\b`), `${forbidden} must not be public`);
    }
  });

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

  it('external responses are visible inside an explicit untrusted boundary', async () => {
    const SOURCE_SENTINEL = 'SOURCE_BODY__f280_3f8d9a6e7c';
    const { externalResponseSummary } = await import('../dist/domains/github-signals/GitHubTrackingEvent.js');

    const review = externalResponseSummary({
      surface: 'conversation comment',
      id: 99,
      author: 'reviewer',
      body: SOURCE_SENTINEL,
    });
    assert.match(review, /\[UNTRUSTED EXTERNAL CONTENT\]/);
    assert.match(review, new RegExp(SOURCE_SENTINEL));
  });
});
