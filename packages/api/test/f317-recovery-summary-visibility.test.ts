import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { AutoSummarizer } from '../src/domains/cats/services/orchestration/AutoSummarizer.js';
import { LiveRecoveryReader } from '../src/domains/concierge/live/recovery/LiveRecoveryReader.js';
import { recoveryFixture, scope } from './helpers/f317-recovery-fixture.js';

test('real AutoSummarizer cannot launder another cat whisper through a same-thread system recap', async () => {
  const f = recoveryFixture();
  const secret = '决定：私密代号 KIMI_ONLY_ALPHA 只给 Kimi 看，不可告诉 Astra';
  for (let i = 0; i < 20; i++) {
    f.messages.append({
      userId: scope.userId,
      threadId: scope.threadId,
      catId: createCatId('kimi'),
      content: `${secret}，第${i}次讨论`,
      mentions: [],
      timestamp: Date.now() + i,
      visibility: 'whisper',
      whisperTo: [createCatId('kimi')],
    });
  }
  const summary = await new AutoSummarizer({ messageStore: f.messages, summaryStore: f.summaries }).maybeSummarize(
    scope.threadId,
  );
  assert.ok(summary);
  assert.equal(summary.createdBy, 'system');
  assert.ok(summary.conclusions.join().includes('KIMI_ONLY_ALPHA'), 'real producer persisted the private material');
  const before = JSON.stringify(f.summaries.get(summary.id));
  const result = await new LiveRecoveryReader(f.options).read(scope, { signal: new AbortController().signal });
  assert.equal(JSON.stringify(result).includes('KIMI_ONLY_ALPHA'), false);
  assert.deepEqual(result.summaries.items, []);
  assert.equal(result.summaries.coverage, 'unavailable_viewer_evidence');
  assert.equal(JSON.stringify(f.summaries.get(summary.id)), before, 'consumer must not rewrite canonical Summary');
});

test('same author, system creator and user creator do not establish a current viewer grant', async () => {
  for (const createdBy of [scope.catId, 'system' as const, 'user' as const]) {
    const f = recoveryFixture();
    const summary = f.summaries.create({
      threadId: scope.threadId,
      createdBy,
      topic: 'private_summary_title',
      conclusions: ['private_summary_conclusion'],
      openQuestions: ['private_summary_question'],
    });
    const item = f.task('private_summary_derived_task');
    // Canonical hydrated legacy field, not a claim that generic create persists it.
    Object.assign(item, { sourceSummaryId: summary.id });
    const result = await new LiveRecoveryReader(f.options).read(scope, { signal: new AbortController().signal });
    assert.equal(JSON.stringify(result).includes('private_summary'), false);
    assert.equal(result.tasks.items.length, 0, 'summary-backed task text cannot be a secondary leak');
    assert.ok(f.tasks.get(item.id), 'withholding projection does not dispose the task');
  }
});
