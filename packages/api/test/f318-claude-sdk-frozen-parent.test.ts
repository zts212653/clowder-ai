import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  assertStudySendWindow,
  studySendWindow,
} from '../../../docs/research/2026-11-18-f338-haiku-sdk/study-send-window.mjs';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { installClaudeSdkSendGuard } from '../src/domains/cats/services/agents/providers/claude-sdk-query.js';
import type { AgentClientActiveRunDispatcher, AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';

function fixture(stage: 'T50' | 'T75') {
  const source = {
    id: 'logical-parent',
    cliSessionId: 'frozen-parent',
    threadId: 'thread',
    userId: 'owner',
    catId: 'haiku55',
    status: 'active',
    lastUsage: {
      costUsd: 0.2,
      cacheObservation: { invocationId: 'source', nativeSessionId: 'frozen-parent', observedAt: 1000 },
    },
  };
  const state = { baselineAt: 1000, source };
  const options: AgentServiceOptions = {
    invocationId: 'timed',
    callbackEnv: { CAT_CAFE_INVOCATION_ID: 'timed', CAT_CAFE_CALLBACK_TOKEN: randomUUID() },
    toolExecutionPolicy: { mode: 'callback_allowlist', allowedCallbackRoutes: [] },
    ...(stage === 'T50'
      ? { cacheRetentionReplay: { sourceInvocationId: 'source', nativeSystemPrompt: 'FROZEN' } }
      : {}),
  };
  return { state, options, now: state.baselineAt + (stage === 'T50' ? 50 : 75) * 60000 };
}

for (const stage of ['T50', 'T75'] as const) {
  for (const missing of [false, true]) {
    const currentId = missing ? undefined : 'changed-parent';
    test(`F338: ${stage} ${missing ? 'missing' : 'changed'} current cannot select a new SDK parent`, async (t) => {
      const { state, options, now } = fixture(stage);
      let queries = 0;
      try {
        const window = studySendWindow(state, stage, currentId);
        t.after(installClaudeSdkSendGuard((context) => assertStudySendWindow(window, context, now)));
        const service = new ClaudeSdkAgentService({
          catId: createCatId('haiku55'),
          model: 'claude-haiku-5-5',
          mcpServerPath: '',
          l0CompilerFn: async () => 'L0',
          runtimeResolver: claudeSdkRuntimeFixture,
          queryFn: () => {
            queries++;
            throw new Error('no paid query in test');
          },
        });
        for await (const _event of service.invoke('return', { ...options, sessionId: currentId })) {
          /* drain teardown */
        }
      } catch (error) {
        assert.match(String(error), /parent|session/i);
      }
      assert.equal(queries, 0);
    });

    test(`F338: ${stage} ${missing ? 'missing' : 'changed'} parent cannot queue active SDK input`, async (t) => {
      const { state, options, now } = fixture(stage);
      let dispatch: AgentClientActiveRunDispatcher['dispatch'] | undefined;
      let accepted = false;
      let delivered = 0;
      const service = new ClaudeSdkAgentService({
        catId: createCatId('haiku55'),
        model: 'claude-haiku-5-5',
        mcpServerPath: '',
        l0CompilerFn: async () => 'L0',
        runtimeResolver: claudeSdkRuntimeFixture,
        queryFn: ({ prompt }) => ({
          close() {},
          async *[Symbol.asyncIterator]() {
            const input = prompt[Symbol.asyncIterator]();
            const first = (await input.next()).value;
            yield { type: 'system', subtype: 'init', session_id: currentId ?? 'frozen-parent' };
            // An existing carrier predates this stage; install the stage window only for the next input.
            const window = studySendWindow(state, stage, currentId);
            if (missing) delete window.sessionId;
            t.after(installClaudeSdkSendGuard((context) => assertStudySendWindow(window, context, now)));
            assert.ok(dispatch);
            accepted = (await dispatch({ text: 'timed return' }, { expectedInvocationId: 'timed' })).accepted;
            if (accepted && !(await input.next()).done) delivered++;
            yield {
              type: 'result',
              subtype: 'success',
              session_id: currentId ?? 'frozen-parent',
              num_turns: 1,
              user_message_uuids: [first.uuid],
              queued_turn_count: 0,
            };
            yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
          },
        }),
      });
      for await (const _event of service.invoke('primary', {
        ...options,
        sessionId: 'frozen-parent',
        activeRunDispatch: {
          invocationId: 'timed',
          register: (registration) => {
            dispatch = registration.dispatch;
            return () => {};
          },
        },
      })) {
        /* drain teardown */
      }
      assert.equal(accepted, false);
      assert.equal(delivered, 0);
    });
  }
}
