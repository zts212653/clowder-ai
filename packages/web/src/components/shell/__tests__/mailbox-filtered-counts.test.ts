import assert from 'node:assert/strict';
import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { test } from 'vitest';
import { projectCompanionDecisions } from '../../../../../api/src/routes/companion-decision-projection.js';
import type { DecisionSourceRead } from '../../../../../api/src/routes/companion-decision-sources.js';
import type { UserMentionTodoRead } from '../../../../../api/src/routes/user-mention-todo-projection.js';
import { approval } from '../../../../../api/test/growing/unified-attention-fixtures.js';
import { deriveMailboxPanelState, deriveMailboxState } from '../unified-mailbox-state';

const source = (coverage: DecisionSourceRead['coverage']): DecisionSourceRead => ({
  status: 'available',
  exhaustiveness: 'complete',
  startedAt: 1,
  observedAt: 2,
  coverage,
});

for (const period of ['earlier', 'handled'] as const) {
  test(`the actual ${period} mention projection preserves global decisions while its panel is empty`, () => {
    const mentions: UserMentionTodoRead = {
      items: [],
      period,
      counts: { today: 0, week: 0, earlier: 0, handled: 0 },
      state: source('explicit_user_mentions'),
    };
    const read: UnifiedAttentionReadV1 = projectCompanionDecisions(
      { items: [approval('still-pending')], coverage: { state: 'complete' } },
      { ownerReads: [], coverage: { state: 'complete' } },
      'owner',
      { offset: 0, limit: 20 },
      3,
      {
        approvals: source('all_registered_F246_producers'),
        needsMe: source('current_linked_F310_five_producers'),
        structuredChoices: source('pending_f306_structured_choices'),
      },
      mentions,
    );
    assert.equal(read.attentionCount, 1);
    assert.equal(read.totalCount, 0);
    assert.deepEqual(read.items, []);
    assert.deepEqual(deriveMailboxState({ kind: 'ok', read }), {
      kind: 'has-items',
      count: 1,
      partial: false,
    });
    assert.deepEqual(deriveMailboxPanelState({ kind: 'ok', read }), { kind: 'empty' });
  });
}
