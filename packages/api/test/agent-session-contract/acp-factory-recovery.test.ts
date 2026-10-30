import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRefreshingAcpSessionProvider } from '../../src/domains/cats/services/agents/session-contract/acp-session-provider.ts';

const service = {
  async *invoke() {
    yield { type: 'text' as const, content: 'recovered', catId: 'codex', timestamp: 1 };
    yield { type: 'done' as const, catId: 'codex', timestamp: 2 };
  },
};
const input = {
  prompt: { kind: 'frozen' as const, text: 'hello' },
  invocation: { invocationId: 'inv', callbackEnv: {} },
};
async function turn(provider: ReturnType<typeof createRefreshingAcpSessionProvider>, id = 'host') {
  await provider.openSession({ sessionId: id });
  const started = await provider.startTurn(id, input, new AbortController().signal);
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error('turn not started');
  const events = [];
  for await (const event of started.events) events.push(event);
  return events;
}

for (const first of ['throw', 'null'])
  test(`a ${first} factory result is retried by the next invocation without a revision change`, async () => {
    let calls = 0;
    const provider = createRefreshingAcpSessionProvider({
      catId: 'codex',
      scope: {},
      revision: () => 1,
      createService: async () => {
        calls++;
        if (calls === 1) {
          if (first === 'throw') throw new Error('bootstrap rejected');
          return null;
        }
        return service;
      },
    });
    await assert.rejects(turn(provider), /bootstrap rejected|unavailable/);
    assert.ok((await turn(provider)).some((event) => event.type === 'output' && event.text === 'recovered'));
    await turn(provider);
    assert.equal(calls, 2, 'successful service stays cached');
  });

test('concurrent first calls share failure and a newer revision survives an older failure', async () => {
  let revision = 1;
  let calls = 0;
  let rejectFirst: (reason: Error) => void = () => assert.fail('factory not started');
  const first = new Promise<typeof service>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const provider = createRefreshingAcpSessionProvider({
    catId: 'codex',
    scope: {},
    revision: () => revision,
    createService: () => {
      calls++;
      return calls === 1 ? first : Promise.resolve(service);
    },
  });
  const old = turn(provider, 'old');
  const peer = turn(provider, 'peer');
  const failures = Promise.allSettled([old, peer]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  revision++;
  const fresh = turn(provider, 'fresh');
  rejectFirst(new Error('old bootstrap failure'));
  assert.ok((await fresh).some((event) => event.type === 'output'));
  assert.ok((await failures).every((result) => result.status === 'rejected'));
  await turn(provider, 'after');
  assert.equal(calls, 2, 'old failure must not clear the fresh successful service');
});
