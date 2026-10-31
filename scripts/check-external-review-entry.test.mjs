import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as reviewGuard from './check-external-review-closure.mjs';

const routingFixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../packages/api/test/harness-eval/fixtures/review-completion-routing.json'),
    'utf8',
  ),
);

describe('external review entry mode hard guard', () => {
  it('rejects formal external PR task and tracker instructions that forbid GitHub delivery', () => {
    assert.equal(typeof reviewGuard.checkReviewEntry, 'function');

    const formal = routingFixture.entryPairs.find((pair) => pair.id === 'external-pr-task-formal');
    assert.ok(formal);
    const contradictions = [
      formal.counterfactual.input,
      {
        ...formal.counterfactual.input,
        reviewMode: undefined,
        entry: {
          ...formal.counterfactual.input.entry,
          kind: 'tracker',
          instructions: '跟踪新 HEAD 后给出正式结论，但不要在 GitHub 留评论。',
        },
      },
      {
        ...formal.counterfactual.input,
        entry: {
          ...formal.counterfactual.input.entry,
          kind: 'tracker',
          instructions: '正式复审后结论不落 GitHub，只在当前 Thread 回传。',
        },
      },
    ];

    for (const input of contradictions) {
      const result = reviewGuard.checkReviewEntry(input);
      assert.equal(result.intent, 'external');
      assert.equal(result.mode, 'formal');
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /no-comment|GitHub delivery/i);
    }
  });

  it('does not confuse an ordinary scope exclusion with a GitHub delivery ban', () => {
    const formal = routingFixture.entryPairs.find((pair) => pair.id === 'external-pr-task-formal');
    assert.ok(formal);
    const scoped = structuredClone(formal.positive.input);
    scoped.entry.instructions = 'Do not comment on code outside the diff; publish the formal review on GitHub.';
    const result = reviewGuard.checkReviewEntry(scoped);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('does not treat ordinary GitHub context as a delivery ban', () => {
    const formal = routingFixture.entryPairs.find((pair) => pair.id === 'external-pr-task-formal');
    assert.ok(formal);
    const legitimateInstructions = [
      '本次修改不影响 GitHub 上已有评论；正式结论仍回写同一 PR。',
      '如果不是 GitHub 官方评论就忽略；正式结论仍回写同一 PR。',
      '对不明确的地方请在 GitHub 上留评论确认。',
      '尽量不在 GitHub 上留言过多；正式 verdict 仍须回写同一 PR。',
      'There is no GitHub access token yet; deliver the verdict via the same PR.',
    ];

    for (const instructions of legitimateInstructions) {
      const input = structuredClone(formal.positive.input);
      input.entry.instructions = instructions;
      const result = reviewGuard.checkReviewEntry(input);
      assert.equal(result.ok, true, `${instructions}\n${result.errors.join('\n')}`);
    }
  });

  it('rejects canonical English variants that suppress GitHub delivery', () => {
    const formal = routingFixture.entryPairs.find((pair) => pair.id === 'external-pr-task-formal');
    assert.ok(formal);
    const deliveryBans = [
      'Must not leave any GitHub review.',
      'Do not comment publicly on GitHub.',
      'Skip GitHub comments.',
      'Omit GitHub reviews.',
      'Refrain from commenting on GitHub.',
      'Avoid GitHub comments.',
      'Keep the review out of GitHub.',
    ];

    for (const instructions of deliveryBans) {
      const input = structuredClone(formal.positive.input);
      input.entry.instructions = instructions;
      const result = reviewGuard.checkReviewEntry(input);
      assert.equal(result.ok, false, instructions);
      assert.match(result.errors.join('\n'), /no-comment|GitHub delivery/i);
    }
  });

  it('allows private no-comment work only when advisory_read_only is explicit', () => {
    assert.equal(typeof reviewGuard.checkReviewEntry, 'function');

    const advisory = routingFixture.entryPairs.find((pair) => pair.id === 'external-pr-tracker-advisory');
    assert.ok(advisory);
    const result = reviewGuard.checkReviewEntry(advisory.positive.input);
    assert.equal(result.intent, 'external');
    assert.equal(result.mode, 'advisory_read_only');
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('never lets advisory_read_only enter review-complete state', () => {
    assert.equal(typeof reviewGuard.checkReviewEntry, 'function');
    assert.equal(typeof reviewGuard.checkReviewCompletion, 'function');

    const advisory = routingFixture.entryPairs.find((pair) => pair.id === 'external-pr-tracker-advisory');
    assert.ok(advisory);
    const entryResult = reviewGuard.checkReviewEntry(advisory.counterfactual.input);
    const completionResult = reviewGuard.checkReviewCompletion(advisory.counterfactual.input);
    assert.equal(entryResult.ok, false);
    assert.equal(completionResult.ok, false);
    assert.match([...entryResult.errors, ...completionResult.errors].join('\n'), /advisory_read_only.*complete/i);
  });

  it('fails closed on a non-canonical review mode in standalone completion validation', () => {
    const external = routingFixture.pairs.find((pair) => pair.id === 'external-pr-review');
    assert.ok(external);
    const invalidMode = structuredClone(external.positive.input);
    invalidMode.reviewMode = 'ADVISORY_READ_ONLY';

    const result = reviewGuard.checkReviewCompletion(invalidMode);
    assert.equal(result.intent, 'external');
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /mode.*formal.*advisory_read_only/i);
  });

  it('does not force a local-cat PR handoff onto GitHub', () => {
    const local = routingFixture.pairs.find((pair) => pair.id === 'local-cat-review');
    assert.ok(local);
    const result = reviewGuard.checkReviewCompletion(local.positive.input);
    assert.equal(result.intent, 'local_cat');
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(local.positive.input.completion.route.kind, 'cat_handoff');
  });
});
