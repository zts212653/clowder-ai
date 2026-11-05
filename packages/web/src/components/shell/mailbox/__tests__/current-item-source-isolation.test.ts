import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { parseUnifiedAttentionRead } from '../../parse-unified-attention';
import type { MailboxRead } from '../../unified-mailbox-state';
import { createApprovalSessions } from '../approval-sessions';
import { collectiveFailure } from './collective-failure.fixture';
import { approvalRow, NOW, OWNER, okRead, storeItem } from './mailbox-fixtures';

function harness(row = approvalRow(storeItem({ sourceFeatureId: 'F225' }))) {
  let result = collectiveFailure(okRead([row]));
  let starts = 1,
    generation: number | null = 1;
  const store = row.approval ? [{ ...row.approval, ownerUserId: OWNER }] : [];
  const sessions = createApprovalSessions({
    readsStarted: () => starts,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => store,
    attempts: () => ({}),
    latestRead: () => ({ result, generation }),
    now: () => NOW,
  });
  return {
    row,
    sessions,
    store,
    read: () => {
      if (result.kind !== 'ok') throw new Error('No current read');
      return result.read;
    },
    setResult: (value: MailboxRead) => {
      result = value;
    },
    setGeneration: (value: number | null) => {
      generation = value;
    },
    startNewRead: () => {
      starts++;
    },
    current: () => sessions.currentItem?.(OWNER, row.decisionRef),
  };
}

describe('Native card current item follows its own source', () => {
  it.each([
    'F225',
    'F231',
    'F193',
    'F221',
    'F139',
    'F321',
  ] as const)('keeps healthy %s under the actual parser-accepted dual Collective outage', (feature) => {
    const h = harness(approvalRow(storeItem({ sourceFeatureId: feature })));
    h.read().sources.needsMe.exhaustiveness = 'partial';
    expect(parseUnifiedAttentionRead(h.read())).not.toBeNull();
    expect(h.current()).toBe(h.read().items[0]);
  });
  it('retains the original complete read behavior and the reported legacy single-path failure', () => {
    const h = harness();
    expect(parseUnifiedAttentionRead(h.read())).not.toBeNull();
    expect(h.current()).toBe(h.read().items[0]);
    h.setResult(okRead([h.row]));
    expect(h.current()).toBe(h.read().items[0]);
  });
  it('does not require Needs Me for the original runtime choices', () => {
    const row: UnifiedAttentionItemV1 = {
      decisionRef: 'choice-request:one',
      kind: 'judgment',
      summary: 'Original choice',
      linkedNeedsMe: [],
      choiceRequest: {
        interactionId: 'one',
        revision: 2,
        title: 'Original choice',
        questions: [
          {
            id: 'q',
            header: 'Question',
            question: 'Choose',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
          },
        ],
        cardRef: { threadId: 'thread', messageId: 'message', blockId: 'card' },
        requesterCatId: 'opus',
        createdAt: 1,
      },
    };
    const h = harness(row);
    h.read().sources.structuredChoices = { ...h.read().sources.approvals, coverage: 'pending_f306_structured_choices' };
    h.read().sources.needsMe.exhaustiveness = 'partial';
    expect(h.current()).toBe(h.read().items[0]);
    const choices = h.read().sources.structuredChoices;
    if (!choices) throw new Error('Expected choices source');
    choices.exhaustiveness = 'partial';
    expect(h.current()).toBeNull();
  });
  it('requires the Needs Me source for owner-backed review rather than treating all healthy-looking rows as writable', () => {
    const row: UnifiedAttentionItemV1 = {
      decisionRef: 'f309.content_review:one',
      kind: 'judgment',
      summary: 'Review',
      linkedNeedsMe: [],
    };
    const h = harness(row);
    expect(h.current()).toBe(h.read().items[0]);
    h.read().sources.needsMe.exhaustiveness = 'partial';
    expect(h.current()).toBeNull();
  });
  it.each(['unavailable', 'partial', 'unknown'] as const)('refuses an approval when its own source is %s', (value) => {
    const h = harness();
    if (value === 'unavailable') h.read().sources.approvals.status = value;
    else h.read().sources.approvals.exhaustiveness = value;
    expect(h.current()).toBeNull();
  });
  it.each([
    'unauthenticated',
    'forbidden',
    'invalid',
  ] as const)('does not downgrade a cross-source %s identity failure into mere unavailability', (status) => {
    const h = harness();
    h.read().sources.collectiveAccountabilityRequests!.status = status;
    expect(h.current()).toBeNull();
  });
  it.each([
    'ambiguous_decision_identity',
    'producer_version_or_link_unverified',
    'original_approval_card_unverified',
    'unknown_consistency_reason',
  ])('blocks %s even alongside a recognized availability failure', (reason) => {
    const h = harness();
    h.read().consistency.reasons.push(reason);
    expect(h.current()).toBeNull();
  });
  it('refuses an ambiguous address, another owner and stale or in-flight generation', () => {
    const h = harness();
    h.read().items.push({ ...h.row });
    expect(h.current()).toBeNull();
    h.read().items.pop();
    h.read().identity.ownerUserId = 'foreign';
    expect(h.current()).toBeNull();
    h.read().identity.ownerUserId = OWNER;
    h.setGeneration(null);
    expect(h.current()).toBeNull();
    h.setGeneration(1);
    h.startNewRead();
    expect(h.current()).toBeNull();
  });
  it('refuses a cross-producer reuse of the same proposal identity even without a global diagnostic', () => {
    const h = harness();
    h.read().items.push(approvalRow(storeItem({ sourceFeatureId: 'F231' }), 'another-ref'));
    expect(h.current()).toBeNull();
  });
  it('ordinary approval authorization also requires its source and exact store value while unrelated outages stay isolated', () => {
    const h = harness(approvalRow(storeItem()));
    const session = h.sessions.open({ ownerUserId: OWNER, decisionRef: h.row.decisionRef, approval: h.row.approval! });
    expect(h.sessions.authorize(session.key)).toBe(true);
    h.store[0].summary = 'Changed since displayed';
    expect(h.sessions.authorize(session.key)).toBe(false);
  });
});
