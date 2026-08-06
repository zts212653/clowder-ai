import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CALLBACK_SOURCE = readFileSync(new URL('../src/routes/callbacks.ts', import.meta.url), 'utf8');
const PROPOSAL_GATE_SOURCE = readFileSync(
  new URL('../src/routes/proposal-community-pr-gate.ts', import.meta.url),
  'utf8',
);
const PROPOSAL_TRANSITION_SOURCE = readFileSync(
  new URL('../src/routes/proposal-community-pr-transition.ts', import.meta.url),
  'utf8',
);

describe('F280 PR wait cutover guards', () => {
  it('the callback route accepts typed wait inputs and contains no legacy registration keys', () => {
    const start = CALLBACK_SOURCE.indexOf('const registerPrTrackingSchema');
    const end = CALLBACK_SOURCE.indexOf("app.post('/api/callbacks/register-pr-tracking'", start);
    assert.notEqual(start, -1, 'registerPrTrackingSchema must exist');
    assert.notEqual(end, -1, 'register-pr-tracking route must exist');
    const schemaSource = CALLBACK_SOURCE.slice(start, end);

    for (const required of ['repoFullName', 'prNumber', 'when', 'nextStep', 'expiresAt']) {
      assert.match(schemaSource, new RegExp(`\\b${required}\\b`), `${required} must be in the callback schema`);
    }
    for (const forbidden of ['intent', 'wakePolicy', 'instructions', 'eventWait', 'baseline']) {
      assert.doesNotMatch(schemaSource, new RegExp(`\\b${forbidden}\\b`), `${forbidden} must not be public`);
    }
  });

  it('formal community review approval never promises or creates automatic PR tracking', () => {
    const source = `${PROPOSAL_GATE_SOURCE}\n${PROPOSAL_TRANSITION_SOURCE}`;
    for (const forbidden of [
      'intent=review',
      'intent=merge',
      'wakePolicy',
      'eventWait',
      'human_participant_activity',
      "kind: 'pr_tracking'",
    ]) {
      assert.equal(source.includes(forbidden), false, `proposal flow still contains ${forbidden}`);
    }
  });

  it('TaskStore exposes complete replacement CAS instead of relying on deep patch deletion', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const store = new TaskStore();
    assert.equal(typeof store.replaceAutomationStateIfGeneration, 'function');
  });

  it('compact review and CI renderers never include raw source body or legacy instructions', async () => {
    const SOURCE_SENTINEL = 'SOURCE_BODY__f280_3f8d9a6e7c';
    const INSTRUCTION_SENTINEL = 'LEGACY_INSTRUCTIONS__f280_a6d2c19b4e';
    const { buildReviewFeedbackContent } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
    const { buildCiMessageContent } = await import('../dist/infrastructure/email/ci-message-content.js');

    const review = buildReviewFeedbackContent(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        newComments: [
          {
            id: 99,
            author: 'reviewer',
            body: SOURCE_SENTINEL,
            createdAt: '2026-07-30T00:00:00Z',
            commentType: 'conversation',
          },
        ],
        newDecisions: [],
      },
      INSTRUCTION_SENTINEL,
    );
    const ci = buildCiMessageContent(
      {
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'abc123456789',
        prState: 'open',
        aggregateBucket: 'fail',
        checks: [{ name: 'tests', bucket: 'fail', description: SOURCE_SENTINEL }],
      },
      INSTRUCTION_SENTINEL,
    );

    for (const rendered of [review, ci]) {
      assert.equal(rendered.includes(SOURCE_SENTINEL), false, 'raw source body leaked into wake message');
      assert.equal(rendered.includes(INSTRUCTION_SENTINEL), false, 'legacy instructions leaked into wake message');
      assert.match(rendered, /PR #7|owner\/repo#7/);
    }
  });
});
