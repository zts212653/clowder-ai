import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Ephemeral implementation of the read-cursor port; the original routes and mention lifecycle remain unchanged. */
export async function createInboxReadFixture() {
  const cursors = new Map();
  const readStateStore = {
    get(userId, threadId) {
      return cursors.get(`${userId}:${threadId}`) ?? null;
    },
    ack(userId, threadId, lastReadMessageId, lastReadVisibilityCursor) {
      const key = `${userId}:${threadId}`;
      if ((cursors.get(key)?.lastReadMessageId ?? '') >= lastReadMessageId) return false;
      cursors.set(key, { userId, threadId, lastReadMessageId, lastReadVisibilityCursor, updatedAt: Date.now() });
      return true;
    },
    async getUnreadSummaries(userId, threadIds, messages) {
      return Promise.all(
        threadIds.map(async (threadId) => {
          const remaining = await messages.getByThreadAfter(
            threadId,
            this.get(userId, threadId)?.lastReadMessageId,
            undefined,
            userId,
            { evidence: 'durable_owner_read' },
          );
          return { threadId, unreadCount: remaining.length, hasUserMention: remaining.some((m) => m.mentionsUser) };
        }),
      );
    },
    deleteByThread(threadId) {
      for (const [key, value] of cursors) if (value.threadId === threadId) cursors.delete(key);
    },
  };
  const fixture = await createInboxProposalFixture({ readStateStore });
  function request(title, owner = 'default-user') {
    const thread = fixture.threads.create(owner, title, 'default');
    const message = fixture.messages.append({
      userId: owner,
      threadId: thread.id,
      from: { kind: 'agent', catId: 'codex61-sol' },
      mentionsUser: true,
      content: `Controlled @you: ${title}`,
      timestamp: Date.now(),
    });
    return { thread, message };
  }
  return {
    ...fixture,
    cursors,
    readStateStore,
    request,
    inbox: request('Read from the inbox'),
    sidebar: request('Read from the sidebar'),
    foreign: request('Foreign owner request', 'other-owner'),
  };
}
