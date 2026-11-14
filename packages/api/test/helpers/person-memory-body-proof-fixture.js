import { createHash } from 'node:crypto';
import { PersonMemoryOwnerSourceReader } from '../../src/domains/memory/people/PersonMemoryOwnerSourceReader.ts';

export const owner = 'owner-1';
export const body = 'Owner recorded that Mira owns the blue notebook.';
export const excerpt = 'Mira owns the blue notebook';
export const ref = { kind: 'message', threadId: 'thread-body-proof', messageId: 'message-body-proof' };
export const binding = {
  sourceId: 'source-1',
  target: { kind: 'claim', draftId: 'person_draft_body' },
  role: 'reported_fact',
};
// Before #4743, message_text proofs bound the normalized body, even when quote attachments existed.
export const historicalBodyDigest = createHash('sha256').update(body.normalize('NFKC').trim()).digest('hex');
export const quote = {
  type: 'context_attachment',
  attachment: {
    v: 1,
    id: 'ctx-quote-body-proof',
    kind: 'quote',
    text: 'Third-party statement, not owner evidence.',
    comment: 'Owner response to that quotation.',
    source: { kind: 'message', threadId: 'quoted-thread', messageId: 'quoted-message' },
  },
};
export const clean = {
  id: ref.messageId,
  threadId: ref.threadId,
  userId: owner,
  catId: null,
  from: { kind: 'user', userId: owner },
  content: body,
  contentBlocks: [quote],
  timestamp: 1,
  deliveryStatus: 'delivered',
};

export function fixture() {
  let message = structuredClone(clean);
  let thread = { id: ref.threadId, createdBy: owner };
  const deps = {
    messageStore: { getById: async () => message },
    threadStore: { get: async () => thread, list: async () => [] },
  };
  const source = {
    sourceId: 'source-1',
    kind: 'message_text',
    sourceRef: ref,
    ownerUserId: owner,
    resolvedDigest: historicalBodyDigest,
    excerpt,
  };
  const item = {
    ownerUserId: owner,
    recordedAt: Date.UTC(2026, 8, 24),
    materializedBy: {
      kind: 'card_approval',
      candidateId: 'person_candidate_body',
      draftId: 'person_draft_body',
      authorizedAt: Date.UTC(2026, 8, 24),
    },
    sourceRefs: [ref],
    typedProvenance: { sources: [source], assertionBindings: [binding] },
  };
  const reasons = [];
  return {
    item,
    deps,
    reasons,
    read: () => new PersonMemoryOwnerSourceReader(deps).read(owner, item, (reason) => reasons.push(reason)),
    setMessage: (value) => {
      message = value;
    },
    setThread: (value) => {
      thread = value;
    },
  };
}
