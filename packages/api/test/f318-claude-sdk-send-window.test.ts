import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  assertStudySendWindow,
  studySendWindow,
} from '../../../docs/research/2026-11-18-f338-haiku-sdk/study-send-window.mjs';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import {
  assertClaudeSdkSendCurrent,
  installClaudeSdkSendGuard,
} from '../src/domains/cats/services/agents/providers/claude-sdk-query.js';
import type { AgentClientActiveRunDispatcher, AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';

function state() {
  return {
    baselineAt: 1000,
    source: {
      id: 'logical',
      cliSessionId: 'native-parent',
      threadId: 'thread',
      userId: 'owner',
      catId: 'haiku55',
      status: 'active',
      lastUsage: { cacheObservation: { invocationId: 'source', nativeSessionId: 'native-parent', observedAt: 1000 } },
    },
  };
}

for (const stage of ['T50', 'T75'] as const)
  for (const late of [true, false])
    test(`F338: ${stage} ${late ? 'crosses its window during async preparation and constructs zero SDK queries' : 'admits an in-window SDK query'}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'f338-sdk-window-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const window = studySendWindow(state(), stage, 'native-parent');
      let now = window.deadlineAt - 1000,
        queries = 0;
      const context = {
        catId: 'haiku55',
        model: 'claude-haiku-5-5',
        sessionId: 'native-parent',
        ...(stage === 'T50' ? { retentionSourceInvocationId: 'source' } : {}),
      };
      assertStudySendWindow(window, context, now); // the wait returned while the window was still open
      t.after(installClaudeSdkSendGuard((send) => assertStudySendWindow(window, send, now)));
      const options: AgentServiceOptions = {
        invocationId: 'timed',
        sessionId: 'native-parent',
        workingDirectory: root,
        callbackEnv: { CAT_CAFE_INVOCATION_ID: 'timed', CAT_CAFE_CALLBACK_TOKEN: randomUUID() },
        toolExecutionPolicy: { mode: 'callback_allowlist', allowedCallbackRoutes: [] },
        beforeProviderLaunch: async () => {
          await Promise.resolve();
          now += late ? 1001 : 500;
          return { requestGenerationId: 'timed', generationOrdinal: 1, sessionId: 'logical' };
        },
        ...(stage === 'T50'
          ? { cacheRetentionReplay: { sourceInvocationId: 'source', nativeSystemPrompt: 'FROZEN' } }
          : {}),
      };
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
      for await (const _event of service.invoke('Reply OK.', options)) {
        /* drain teardown */
      }
      assert.equal(queries, late ? 0 : 1);
    });

test('F338: a final send guard cannot defer its decision asynchronously', (t) => {
  t.after(installClaudeSdkSendGuard(async () => {}));
  assert.throws(() => assertClaudeSdkSendCurrent({ catId: 'haiku55', model: 'claude-haiku-5-5' }), /synchronous/);
});

test('F338: T75 crossing the window during interrupt never queues an active SDK input', async (t) => {
  const window = studySendWindow(state(), 'T75', 'native-parent');
  let now = window.deadlineAt - 1000;
  t.after(installClaudeSdkSendGuard((context) => assertStudySendWindow(window, context, now)));
  let dispatch: AgentClientActiveRunDispatcher['dispatch'] | undefined;
  let accepted: boolean | undefined;
  let delivered = 0;
  const service = new ClaudeSdkAgentService({
    catId: createCatId('haiku55'),
    model: 'claude-haiku-5-5',
    mcpServerPath: '',
    l0CompilerFn: async () => 'L0',
    runtimeResolver: claudeSdkRuntimeFixture,
    queryFn: ({ prompt }) => ({
      close() {},
      interrupt: async () => {
        await Promise.resolve();
        now = window.deadlineAt + 1;
      },
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        const first = (await input.next()).value;
        yield { type: 'system', subtype: 'init', session_id: 'native-parent' };
        assert.ok(dispatch);
        const receipt = await dispatch({ text: 'timed return' }, { expectedInvocationId: 'active', force: true });
        accepted = receipt.accepted;
        if (accepted && !(await input.next()).done) delivered++;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-parent',
          num_turns: 1,
          user_message_uuids: [first.uuid],
          queued_turn_count: 0,
        };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      },
    }),
  });
  for await (const _event of service.invoke('primary', {
    invocationId: 'active',
    sessionId: 'native-parent',
    activeRunDispatch: {
      invocationId: 'active',
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
