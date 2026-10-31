import { createCanonicalLiveSourceFixture } from './1398-live-source-fixture.mjs';

// The replacement protocol retains exact message identities; it never coalesces bodies or asks for a second completion.
export async function liveExactDispatchFixture() {
  const f = await createCanonicalLiveSourceFixture(
    { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
    'agent',
    { targetCats: ['codex-astra'] },
  );
  return {
    ...f,
    readExact: (message) => f.read(`&messageId=${message.id}&before=0&after=0`),
    async addSource(content) {
      return (
        await f.queue.send(
          f.store,
          {
            threadId: 'home',
            userId: 'owner',
            from: { kind: 'agent', catId: 'opus' },
            content,
            mentions: ['codex-astra'],
            timestamp: Date.now(),
            deliveryStatus: 'queued',
          },
          {
            kind: 'conversation_input',
            threadId: 'home',
            userId: 'owner',
            from: { kind: 'agent', catId: 'opus' },
            ownerAuthProvenance: 'strict',
            content,
            targetCats: ['codex-astra'],
            intent: 'execute',
            authorIntentByCatId: {
              'codex-astra': { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
            },
          },
        )
      ).message;
    },
  };
}
