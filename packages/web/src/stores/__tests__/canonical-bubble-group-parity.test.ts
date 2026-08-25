import { createCatId, projectMarkdownReadableText } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
// Reaching across the package boundary is the point: this test exists to prove the two
// implementations of one identity agree. Importing a copy would prove nothing.
import { canonicalSourceGroup } from '../../../../api/src/domains/cats/services/context/MessageBundleSourceGroup';
import { projectMessageBundleGroupQuoteSourceV3 } from '../../../../api/src/domains/cats/services/context/MessageBundleSourceProjection';
import { projectCanonicalBubbles } from '../bubble-projection';
import type { ChatMessage } from '../chat-types';

/**
 * A record that satisfies *both* contracts at once. That is the point: if the two sides ever stop
 * accepting the same shape, this test must fail to compile rather than paper it over with a cast.
 */
type StoredRecord = Parameters<typeof canonicalSourceGroup>[0][number];
type ParityRecord = ChatMessage & StoredRecord;

/**
 * ADR-033: the server's mirror of the browser's bubble identity must be executable, not a comment.
 *
 * Every F294 selection is made on a *bubble* the browser projected, while every server check runs
 * on stored *rows*. When the two disagree about which rows form one bubble, a selection either
 * loses part of what the human picked or is refused as unavailable — both have already reached
 * production. This pins the two groupings against each other on the same records.
 */
function makeRecord(overrides: Partial<ParityRecord> & { id: string }): ParityRecord {
  return {
    threadId: 'thread-source',
    userId: 'user-1',
    catId: createCatId('codex-sol'),
    content: '',
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'delivered',
    type: 'assistant',
    ...overrides,
  };
}

function streamRow(id: string, content: string, timestamp: number, invocationId = 'inv-1'): ParityRecord {
  return makeRecord({
    id,
    content,
    timestamp,
    origin: 'stream',
    isStreaming: false,
    extra: { stream: { invocationId, turnInvocationId: invocationId } },
  });
}

/** The rows the browser says belong to the bubble carrying `anchorId`. */
function browserBubbleIds(records: ParityRecord[], anchorId: string): string[] | null {
  const { messages } = projectCanonicalBubbles({ records });
  const bubble = messages.find((candidate) => candidate.id === anchorId);
  if (!bubble) return null;
  return [...(bubble.projectionSourceMessageIds ?? [bubble.id])].sort();
}

/** The rows the server says belong to the same bubble. */
function serverGroupIds(records: ParityRecord[], anchorId: string): string[] | null {
  const group = canonicalSourceGroup(records, anchorId);
  return group ? group.map((record) => record.id).sort() : null;
}

const CASES: Array<{ name: string; records: ParityRecord[]; anchorId: string }> = [
  {
    name: 'one invocation split across rows',
    records: [streamRow('anchor', '', 100), streamRow('narration', '第二行才有正文', 101)],
    anchorId: 'anchor',
  },
  {
    name: 'two rows that both carry prose',
    records: [streamRow('anchor', '屏幕上的第一段', 100), streamRow('sibling', '屏幕上的第二段', 101)],
    anchorId: 'anchor',
  },
  {
    name: 'a second invocation stays its own bubble',
    records: [
      streamRow('turn-1-anchor', '第一轮', 100, 'inv-1'),
      streamRow('turn-1-more', '第一轮续', 101, 'inv-1'),
      streamRow('turn-2-anchor', '第二轮', 200, 'inv-2'),
    ],
    anchorId: 'turn-1-anchor',
  },
  {
    name: 'a plain user message is its own bubble',
    records: [makeRecord({ id: 'user-row', type: 'user', catId: undefined, content: 'co-creator说的话' })],
    anchorId: 'user-row',
  },
];

describe('canonical bubble identity is mirrored, not merely documented (ADR-033)', () => {
  for (const { name, records, anchorId } of CASES) {
    it(`agrees on bubble membership: ${name}`, () => {
      const browser = browserBubbleIds(records, anchorId);
      const server = serverGroupIds(records, anchorId);

      expect(browser, 'the browser projector must produce a bubble for this anchor').not.toBeNull();
      expect(server, `server group and browser bubble disagree for ${name}`).toEqual(browser);
    });
  }

  it('projects a cross-row quote in the same readable bubble plane', () => {
    const records = [streamRow('anchor', '屏幕上的第一段', 100), streamRow('sibling', '屏幕上的第二段', 101)];
    const browserBubble = projectCanonicalBubbles({ records }).messages[0];
    const serverGroup = canonicalSourceGroup(records, 'anchor');

    expect(serverGroup).not.toBeNull();
    expect(projectMessageBundleGroupQuoteSourceV3(serverGroup ?? [])).toBe(
      projectMarkdownReadableText(browserBubble?.content ?? ''),
    );
  });
});
