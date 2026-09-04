import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { operationalKnowledgeCueSeeds } from '../../dist/domains/cats/services/agents/routing/route-helpers.js';

describe('F312 operational-knowledge typed predicates', () => {
  it('emits only bounded exact refs from the current task carrier', () => {
    const occurredAt = 1_788_300_000_000;
    assert.deepEqual(
      operationalKnowledgeCueSeeds({
        message: [
          '[对话历史增量 - 1 条]',
          '旧消息提过 ADR-999 和 F999',
          '[/对话历史]',
          '',
          '请按 ADR-020 检查这次实现。',
        ].join('\n'),
        sourceMessageId: 'message-current',
        ownerOriginEligible: true,
        sopStageHint: {
          stage: 'impl',
          suggestedSkill: 'tdd',
          suggestedSkillSource: 'default',
          featureId: 'F312',
        },
        occurredAt,
      }),
      [
        {
          kind: 'accepted_decision_required',
          producer: 'owner_message',
          occurredAt,
          payload: { decisionAnchor: 'ADR-020', sourceMessageId: 'message-current' },
        },
        {
          kind: 'project_source_required',
          producer: 'task_context',
          occurredAt,
          payload: {
            featureId: 'F312',
            selectionSource: 'workflow_feature',
            sourceMessageId: 'message-current',
          },
        },
      ],
    );
  });

  it('fails closed for ambiguous, history-only, or untrusted refs', () => {
    const base = {
      sourceMessageId: 'message-current',
      occurredAt: 1_788_300_000_000,
    };
    assert.deepEqual(
      operationalKnowledgeCueSeeds({
        ...base,
        message: 'Compare ADR-020 with ADR-036 and F200 with F209.',
        ownerOriginEligible: true,
      }),
      [],
    );
    assert.deepEqual(
      operationalKnowledgeCueSeeds({
        ...base,
        message: '[对话历史增量 - 1 条]\nADR-020 F312\n[/对话历史]\n继续',
        ownerOriginEligible: true,
      }),
      [],
    );
    assert.deepEqual(
      operationalKnowledgeCueSeeds({
        ...base,
        message: 'ADR-020 F312',
        ownerOriginEligible: false,
      }),
      [],
    );
  });
});
