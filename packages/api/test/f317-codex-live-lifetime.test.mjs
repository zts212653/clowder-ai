import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

test('a live call accepts subsequent root turns and ends the Host stream only once', async () => {
  const f = wireFixture();
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const observed = [];
  let ready = false;
  const terminalFreshness = [];
  const client = new CodexAppServerClient({
    wire: f.wire,
    freshnessController: { markTurnCompleted: async (id) => terminalFreshness.push(id) },
  });
  const events = [];
  for await (const event of client.run({
    thread: { kind: 'start' },
    prompt: { kind: 'frozen', prompt: 'synthetic call' },
    live: {
      finished,
      ready: async () => {
        ready = true;
        f.push({ method: 'turn/started', params: { threadId: 'native', turn: { id: 'second' } } });
        f.push(f.completed('unrelated', 'foreign'));
        f.push(f.completed('second'));
      },
      observe: async (message) => {
        observed.push(message);
        if (message.method === 'turn/completed' && message.params.turn.id === 'second') finish();
      },
    },
  }))
    events.push(event);
  assert.equal(ready, true);
  assert.deepEqual(terminalFreshness, [], 'retired freshness hooks stay unused across Live child completions');
  const config = f.writes.find((message) => message.method === 'thread/start').params.config;
  assert.deepEqual(config.mcp_servers.unapproved, { enabled: false });
  assert.equal(config['features.shell_tool'], false);
  assert.deepEqual(
    events.filter((event) => event.type === 'app_server.live_turn_completed').map((event) => event.turnId),
    ['first', 'second'],
  );
  assert.equal(events.filter((event) => event.type === 'turn.completed').length, 1);
  assert.equal(
    observed.some((event) => event.params?.threadId === 'foreign'),
    false,
  );
});

test(
  'Host text starts then steers on the same native queue and records actual message sources',
  { timeout: 2000 },
  async () => {
    const f = wireFixture();
    let client;
    let finish;
    const submissions = [];
    const receipts = [];
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    const records = [];
    const outcomes = [];
    const prepared = (input) => ({
      v: 1,
      message: { body: input.text, sourceRefs: [{ owner: 'message', ref: input.sourceRef }] },
      nativeInstructions: [],
      runtime: {},
      tools: {},
      providerNativeVisibility: 'unknown',
    });
    for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'voice bootstrap' },
      prepareRequest: (text) => prepared({ text, sourceRef: 'bootstrap' }),
      prepareLiveRequest: (input) => {
        submissions.push(input);
        return prepared(input);
      },
      beforeProviderLaunch: async (request) => {
        records.push(request);
        return {
          requestGenerationId: `request-${records.length}`,
          generationOrdinal: records.length,
          sessionId: 'session',
        };
      },
      onLiveInputOutcome: async (receipt) => {
        outcomes.push(receipt);
      },
      live: {
        finished,
        ready: async (_thread, port) => {
          client = port;
        },
        observe: async () => {},
      },
    })) {
      if (event.type === 'app_server.live_turn_completed' && event.turnId === 'first') {
        receipts.push(
          client.submitText('look at this', 'message-1'),
          client.submitText('also remember this', 'message-2'),
        );
        void Promise.all(receipts).then(finish);
      }
    }
    assert.deepEqual(await Promise.all(receipts), ['turn-2', 'turn-2']);
    const requests = f.writes.filter((row) => ['turn/start', 'turn/steer'].includes(row.method));
    assert.deepEqual(
      requests.map((row) => row.method),
      ['turn/start', 'turn/start', 'turn/steer'],
    );
    assert.equal(requests[2].params.expectedTurnId, 'turn-2');
    assert.deepEqual(
      submissions.map((row) => row.sourceRef),
      ['message-1', 'message-2'],
    );
    assert.equal(records.length, 3);
    assert.deepEqual(
      outcomes.map((value) => [value.request.requestGenerationId, value.outcome, value.nativeTurnId]),
      [
        ['request-2', 'accepted', 'turn-2'],
        ['request-3', 'accepted', 'turn-2'],
      ],
    );
    assert.ok(
      f.writes
        .filter((row) => row.method === 'thread/realtime/appendText')
        .every((row) => row.params.role === 'developer'),
      'fast context mirrors must not duplicate durable typed input as a second user utterance',
    );
  },
);

test('a Host recovery boundary accepts context inline on the exact native loop', { timeout: 2000 }, async () => {
  const f = wireFixture();
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  let port;
  let waiting = true;
  for await (const event of new CodexAppServerClient({ wire: f.wire }).run({
    thread: { kind: 'start' },
    prompt: { kind: 'frozen', prompt: 'voice bootstrap' },
    prepareLiveRequest: (input) => ({
      v: 1,
      message: {
        body: 'The Host attached source-linked context at its original trust level. Continue this call; this is not a new user request.',
      },
      nativeInstructions: [{ body: input.text, injectionDecision: 'app_server_live_context' }],
      runtime: {},
      tools: {},
      providerNativeVisibility: 'unknown',
    }),
    live: {
      finished,
      ready: async (_thread, client) => {
        port = client;
        assert.equal(typeof port.submitContextAtBoundary, 'function');
        await assert.rejects(
          port.submitContextAtBoundary(
            'premature',
            ['source'],
            'recovery_context',
            new AbortController().signal,
            async () => true,
          ),
          /outside native safe boundary/,
        );
      },
      hasPendingInboxWake: () => waiting,
      onSafeBoundary: async (kind) => {
        assert.equal(kind, 'turn_complete');
        waiting = false;
        assert.equal(
          await port.submitContextAtBoundary(
            'Read exact queued source',
            ['thread_home#message-1'],
            'recovery_context',
            new AbortController().signal,
            async () => true,
          ),
          'turn-2',
        );
      },
      observe: async (row) => {
        if (row.method === 'turn/completed' && row.params.turn.id === 'turn-2') finish();
      },
    },
  })) {
    if (event.type === 'turn.completed') break;
  }
  const starts = f.writes.filter((row) => row.method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.turnTrigger, 'live_context');
  assert.equal(starts[1].params.additionalContext['cat-cafe.live-context'].value, 'Read exact queued source');
});

test('ordinary calls keep the original first-turn completion boundary', async () => {
  const f = wireFixture();
  const events = [];
  const terminalFreshness = [];
  for await (const event of new CodexAppServerClient({
    wire: f.wire,
    freshnessController: { markTurnCompleted: async (id) => terminalFreshness.push(id) },
  }).run({
    thread: { kind: 'start' },
    prompt: { kind: 'frozen', prompt: 'ordinary' },
  }))
    events.push(event);
  assert.equal(events.filter((event) => event.type === 'turn.completed').length, 1);
  assert.deepEqual(terminalFreshness, []);
  assert.equal(
    events.some((event) => event.type === 'app_server.live_turn_completed'),
    false,
  );
});

test('Live never polls household freshness, even when a legacy read grant is present', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = wireFixture();
  let finish;
  let reads = 0;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  for await (const event of new CodexAppServerClient({
    wire: f.wire,
    freshnessController: {
      idle: {
        prepare: async () => {
          reads++;
          return null;
        },
      },
    },
  }).run({
    thread: { kind: 'start' },
    prompt: { kind: 'frozen', prompt: 'voice only' },
    live: { finished, acceptsFreshness: () => true, ready: async () => {}, observe: async () => {} },
  }))
    if (event.type === 'app_server.live_turn_completed')
      setImmediate(() => {
        t.mock.timers.tick(5000);
        finish();
      });
  assert.equal(reads, 0);
  assert.equal(f.writes.filter((row) => row.method === 'turn/start').length, 1);
});
