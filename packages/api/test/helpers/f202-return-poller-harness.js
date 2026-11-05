/**
 * Shared harness for the cloud conversation return poller tests (F202 h3b / h3c-3): a manual
 * scheduler, a package the test answers for, and a poller wired to them. `cats` is the cat
 * configuration the poller and the Host ingest resolve the provider's one cloud cat from; by default
 * exactly one cat is configured for it.
 */
import assert from 'node:assert/strict';
import { PluginConversationReturnPoller } from '../../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/plugin-conversation-return-poller.js';
import { hostManifest, METHODS, settle } from '../f202-w2-3-h3b.fixture.js';

/** A cat configuration source whose cats the test can change while the poller runs. */
export function catConfig(initial = { 'gpt-pro': { provider: 'openai-chatgpt-pro' } }) {
  let configs = initial;
  return {
    getAllConfigs: () => configs,
    set(next) {
      configs = next;
    },
  };
}

export const RETURN = {
  conversationId: 'conversation-1',
  sourceMessageId: 'source-1',
  assistantMessageId: 'assistant-1',
  content: 'the answer',
};
export const CURSOR = {
  conversationId: 'conversation-1',
  sourceMessageId: 'source-1',
  assistantMessageId: 'assistant-1',
};

export function manualScheduler() {
  const entries = [];
  return {
    schedule(run, delayMs) {
      const entry = { run, delayMs, state: 'pending' };
      entries.push(entry);
      return {
        cancel: () => {
          if (entry.state === 'pending') entry.state = 'cancelled';
        },
      };
    },
    pending: () => entries.filter((entry) => entry.state === 'pending').map((entry) => entry.delayMs),
    /** Runs the one pending round and lets it settle; returns the delay it had been scheduled with. */
    async fire() {
      const due = entries.filter((entry) => entry.state === 'pending');
      assert.equal(due.length, 1, 'exactly one round is scheduled');
      due[0].state = 'fired';
      due[0].run();
      await settle();
      return due[0].delayMs;
    },
  };
}

/** A package the test answers for: `answers[method]` is a value, or a function of the input. */
export function fakePackage(registry, pluginId = 'dev.clowder.fake-host') {
  const calls = [];
  const answers = { [METHODS.list]: { returns: [] }, [METHODS.ack]: { status: 'acknowledged' } };
  return {
    calls,
    answers,
    register: () =>
      registry.register({
        provider: 'chatgpt',
        pluginId,
        pluginInstanceId: `pi_${pluginId}`,
        contribution: hostManifest({ pluginId }).contributions[0],
        attempt: async (method, params) => {
          calls.push({ method, params });
          try {
            const answer = answers[method];
            return { status: 'returned', value: typeof answer === 'function' ? await answer(params) : answer };
          } catch (error) {
            return { status: 'failed', effect: 'unknown', error };
          }
        },
      }),
  };
}

export function pollerFor(
  registry,
  { ingest = async () => ({ status: 'persisted', messageId: 'm-1' }), ephemeral, cats = catConfig() } = {},
) {
  const scheduler = manualScheduler();
  const lines = [];
  const ingested = [];
  const poller = new PluginConversationReturnPoller({
    registry,
    provider: 'chatgpt',
    cats,
    ingestService: {
      ingest: async (input) => {
        ingested.push(input);
        return ingest(input);
      },
    },
    logger: {
      info: (context, message) => lines.push({ level: 'info', message, context }),
      warn: (context, message) => lines.push({ level: 'warn', message, context }),
    },
    grantPersistence: ephemeral ? 'ephemeral' : 'durable',
    scheduler,
  });
  return { poller, scheduler, lines, ingested };
}

export const methodsOf = (pkg) => pkg.calls.map((call) => call.method);
