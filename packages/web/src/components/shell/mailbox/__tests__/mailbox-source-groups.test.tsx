import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { block, cardRef, request } from '../../../rich/__tests__/runtime-conversation-test-fixtures';
import { deriveMailboxState } from '../../unified-mailbox-state';
import { MailboxItemGroups } from '../MailboxItemGroups';
import { projectMailboxRows } from '../mailbox-rows';
import { collectiveResultRow, okRead } from './mailbox-fixtures';

function runtime(kind: 'approval' | 'question' | 'elicitation' | 'conversation_decision'): UnifiedAttentionItemV1 {
  return {
    decisionRef: `f306.runtime_interaction:${kind}`,
    kind: 'judgment',
    summary: kind,
    linkedNeedsMe: [],
    runtimeInteraction: {
      interactionId: kind,
      revision: 5,
      requesterCatId: request.owner.catId,
      createdAt: request.createdAt,
      title: kind,
      cardRef,
      ...(kind === 'conversation_decision'
        ? { kind, sourceKind: 'conversation_decision' as const, presentation: block, allowTextResponse: true }
        : { kind, sourceKind: 'provider_request' as const }),
    },
  };
}
function exactReview(): UnifiedAttentionItemV1 {
  return {
    decisionRef: 'f309.content_review:review-native',
    kind: 'judgment',
    summary: 'Review the cover',
    linkedNeedsMe: [
      {
        ownerRead: {
          envelope: {
            subjectRef: 'task:work:review-task',
            revision: 8,
            visibility: { ownerUserId: 'owner-review' },
            freshness: { state: 'current', observedRevision: 8 },
          },
          attentionReceipts: [],
        },
        receipt: {
          eligible: true,
          kind: 'judgment',
          reasonCode: 'content_review_requested',
          producer: {
            producerId: 'f309.content_review',
            subjectRef: 'review-native',
            ownerRef: 'content-review:review-native',
            revision: 5,
          },
          taskRef: { subjectRef: 'task:work:review-task', observedRevision: 8 },
          action: { actionRef: 'content-review:review-native', expectedProducerRevision: 5 },
          reEvaluateActionRef: 'content-review:review-native#reevaluate',
        },
      },
    ],
  };
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('groups all released runtime kinds and the exact content-review receipt under waiting for your decision', async () => {
  const decisions = [
    runtime('approval'),
    runtime('question'),
    runtime('elicitation'),
    runtime('conversation_decision'),
    exactReview(),
    collectiveResultRow(),
  ];
  const other: UnifiedAttentionItemV1 = {
    decisionRef: 'ordinary-judgment',
    kind: 'judgment',
    summary: 'ordinary',
    linkedNeedsMe: [],
  };
  await act(async () =>
    root.render(
      <MailboxItemGroups
        section="pending"
        rows={projectMailboxRows([...decisions, other], [], [])}
        complete
        readKnown
        groupCounts={{ decisions: 6, userMentions: 0, other: 1 }}
        renderRow={(row) =>
          row.kind === 'item' ? (
            <li key={row.key} data-source={row.item.decisionRef}>
              {row.item.summary}
            </li>
          ) : null
        }
      />,
    ),
  );
  const waiting = container.querySelector('[data-testid="mailbox-group-decisions"]');
  for (const item of decisions) expect(waiting?.querySelector(`[data-source="${item.decisionRef}"]`)).not.toBeNull();
  expect(waiting?.querySelector('h3')?.textContent).toContain('6');
  expect(container.querySelector('[data-testid="mailbox-group-other"] li')?.textContent).toBe('ordinary');
});

it.each([
  'approval',
  'question',
  'elicitation',
  'conversation_decision',
  'content_review',
  'collective_result',
] as const)('keeps a confirmed %s visible without inventing an exact number when the source total is absent', (kind) => {
  const item =
    kind === 'content_review' ? exactReview() : kind === 'collective_result' ? collectiveResultRow() : runtime(kind);
  const result = okRead([item], {
    totalCount: undefined,
    attentionCount: undefined,
  });
  expect(deriveMailboxState(result)).toEqual({ kind: 'has-items', count: null, partial: false });
});

it.each([
  'lookalike',
  'stale',
  'wrong_action',
  'missing_owner_ref',
] as const)('does not promote a %s judgment to a decision', (negative) => {
  const item = exactReview(),
    receipt = item.linkedNeedsMe[0].receipt;
  if (negative === 'lookalike') receipt.producer.producerId = 'f292.repair';
  if (negative === 'stale')
    item.linkedNeedsMe[0].ownerRead.envelope.freshness = { state: 'stale', observedRevision: 8 };
  if (negative === 'wrong_action') receipt.action = { actionRef: 'content-review:other', expectedProducerRevision: 5 };
  if (negative === 'missing_owner_ref') delete receipt.producer.ownerRef;
  expect(deriveMailboxState(okRead([item], { totalCount: undefined, attentionCount: undefined }))).toEqual({
    kind: 'partial',
  });
});
