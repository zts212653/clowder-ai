import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isPersonMemoryProposalCardBlock } from '../types/rich.js';

describe('F276 person-memory rich card contract', () => {
  const base = {
    id: 'person-memory-person_candidate_1',
    kind: 'card' as const,
    v: 1 as const,
    title: '要把这位人物记下来吗？',
    actions: [
      {
        label: '去审批',
        action: 'person-memory:open-approval-hub',
        payload: { candidateId: 'person_candidate_1' },
      },
    ],
    meta: {
      kind: 'person_memory_proposal',
      candidateId: 'person_candidate_1',
      subjectDisplayName: '黄挺',
      envelopeRef: 'approval:F276:person_candidate_1',
      decisionSurface: 'approval_hub',
      status: 'pending_approval',
    },
  };

  it('accepts the chat presentation card with one Hub navigation action', () => {
    assert.equal(isPersonMemoryProposalCardBlock(base), true);
  });

  it('rejects inline approve/reject actions so Hub remains the sole decision surface', () => {
    assert.equal(
      isPersonMemoryProposalCardBlock({
        ...base,
        actions: [
          {
            label: '直接同意',
            action: 'person-memory:approve',
            payload: { candidateId: 'person_candidate_1' },
          },
        ],
      }),
      false,
    );
  });

  it('rejects a card that claims a second decision surface', () => {
    assert.equal(
      isPersonMemoryProposalCardBlock({
        ...base,
        meta: { ...base.meta, decisionSurface: 'chat' },
      }),
      false,
    );
  });

  it('rejects a malformed human-visible proposal subject', () => {
    assert.equal(
      isPersonMemoryProposalCardBlock({
        ...base,
        meta: { ...base.meta, subjectDisplayName: '   ' },
      }),
      false,
    );
  });
});
