/**
 * #1532: while the Host Adapter answers HOST_UNAVAILABLE (ChatGPT Pro not installed, or its helper not
 * running), the reply poll backs off exponentially up to one check a minute and logs only changes of
 * state, instead of checking and logging every second. The first answer restores the normal cadence.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PersonalChromeAssistantReturnPoller } from '../src/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-assistant-return-poller.js';

const BACKING_OFF =
  '[F247] personal Chrome Host Adapter unavailable; assistant return polling backs off exponentially, up to one check per 60s, until it answers';
const RESUMED = '[F247] personal Chrome Host Adapter answered; assistant return polling resumed';

const reply = {
  conversationId: 'conversation-7',
  sourceMessageId: 'source-message-9',
  assistantMessageId: 'conversation-turn-43',
  content: 'bounded assistant final',
};

function unavailable() {
  return Object.assign(new Error('personal Chrome Host Adapter is not installed'), { code: 'HOST_UNAVAILABLE' });
}

/**
 * A poller on a stepped monotonic clock. The adapter fails `failures` times, then answers with the
 * waiting replies; like the native inbox, a reply is listed until it is acknowledged.
 */
function harness(options: { failures: number; replies?: Array<typeof reply> }) {
  let clock = 0;
  let remainingFailures = options.failures;
  const inbox = [...(options.replies ?? [])];
  const calls: number[] = [];
  const logs: string[] = [];
  const ingested: unknown[] = [];
  const acknowledgements: Array<[string, string, string]> = [];
  const acknowledgedAt: number[] = [];
  const poller = new PersonalChromeAssistantReturnPoller({
    adapter: {
      list_assistant_returns: async () => {
        calls.push(clock);
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw unavailable();
        }
        return inbox.slice(0, 1);
      },
      ack_assistant_return: async (conversationId, sourceMessageId, assistantMessageId) => {
        acknowledgements.push([conversationId, sourceMessageId, assistantMessageId]);
        acknowledgedAt.push(clock);
        inbox.shift();
      },
    },
    ingestService: {
      ingest: async (input) => {
        ingested.push(input);
        return { status: 'persisted', messageId: 'callback-message-1' };
      },
    },
    logger: {
      debug: (_context, message) => logs.push(message),
      warn: (_context, message) => logs.push(message),
    },
    grantPersistence: 'durable',
    monotonicNow: () => clock,
  });
  return {
    calls,
    logs,
    ingested,
    acknowledgements,
    acknowledgedAt,
    async tickUntil(untilMs: number) {
      for (; clock <= untilMs; clock += 1_000) await poller.drainOnce();
      clock -= 1_000;
    },
  };
}

/** A tick every second from 14 s to 20 s: the normal cadence after the adapter answers at 14 s. */
const RECOVERED_CADENCE = [14_000, 15_000, 16_000, 17_000, 18_000, 19_000, 20_000];

describe('PersonalChromeAssistantReturnPoller when the Host Adapter is unavailable', () => {
  it('backs off exponentially to one check a minute and logs the change of state once', async () => {
    const h = harness({ failures: Number.POSITIVE_INFINITY });

    await h.tickUntil(180_000);

    // 2 s, 4 s, 8 s, 16 s, 32 s, then capped at 60 s: a handful of checks, not one per second.
    assert.deepEqual(h.calls, [0, 2_000, 6_000, 14_000, 30_000, 62_000, 122_000]);
    assert.deepEqual(h.logs, [BACKING_OFF]);
  });

  it('resumes the normal cadence as soon as the adapter answers, with one line', async () => {
    const h = harness({ failures: 3 });

    await h.tickUntil(20_000);

    // Fails at 0, 2 s and 6 s; answers at 14 s, then polls every second again.
    assert.deepEqual(h.calls, [0, 2_000, 6_000, ...RECOVERED_CADENCE]);
    assert.deepEqual(h.logs, [BACKING_OFF, RESUMED]);
  });

  it('delivers a reply that waited through the backoff: ingested once, acknowledged at its exact source', async () => {
    const h = harness({ failures: 3, replies: [reply] });

    await h.tickUntil(20_000);

    assert.deepEqual(h.ingested, [{ sourceMessageId: reply.sourceMessageId, content: reply.content }]);
    assert.deepEqual(h.acknowledgements, [[reply.conversationId, reply.sourceMessageId, reply.assistantMessageId]]);
    assert.deepEqual(h.acknowledgedAt, [14_000], 'handled by the first poll that gets an answer, not a later one');
    assert.deepEqual(h.calls, [0, 2_000, 6_000, ...RECOVERED_CADENCE]);
    assert.deepEqual(h.logs, [BACKING_OFF, RESUMED]);
  });

  it('keeps its backoff on a monotonic clock: a backward wall-clock step does not stretch it', async (t) => {
    let wallClock = 3_600_000;
    t.mock.method(Date, 'now', () => wallClock);
    let calls = 0;
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async () => {
          calls += 1;
          throw unavailable();
        },
        ack_assistant_return: async () => {},
      },
      ingestService: { ingest: async () => ({ status: 'duplicate', messageId: 'unused' }) },
      logger: { warn() {} },
      grantPersistence: 'durable',
      pollIntervalMs: 50,
    });

    await poller.drainOnce(); // unavailable: the first retry is due 100 ms later
    await poller.drainOnce();
    assert.equal(calls, 1, 'the backoff still holds before it has elapsed');

    wallClock = 0; // the wall clock steps back an hour
    await new Promise((resolve) => setTimeout(resolve, 150));
    await poller.drainOnce();

    assert.equal(calls, 2, 'the retry follows elapsed time, not the wall clock');
  });
});
