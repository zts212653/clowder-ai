import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyNativeAgentService } from '../../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';

const model = 'gemini-3.8-flash-high';
export const session = 'followup-session';
export const input = (index, state = 'DONE') => ({
  event: 'step_update',
  step_update: { conversation_id: session, step_index: index, step_type: 'user_input', state },
});
export const answer = (index, text, tokens) => ({
  event: 'step_update',
  step_update: {
    conversation_id: session,
    step_index: index,
    step_type: 'agent_response',
    state: 'DONE',
    text_delta: text,
    usage: {
      input_tokens: tokens,
      output_tokens: 2,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: tokens + 2,
    },
  },
});
export const result = (text, turn = 1, status = 'SUCCESS') => ({
  event: 'result',
  result: {
    conversation_id: session,
    response: text,
    status,
    num_turns: turn,
    usage: { input_tokens: turn * 100, output_tokens: turn * 2, total_tokens: turn * 102 },
    ...(status === 'ERROR' ? { error: 'second turn failed' } : {}),
  },
});

export async function runNative(script, { signal, registered = true, invocationId = 'inv', onMessage } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-followup-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    l0CompilerFn: async () => '# Fixture identity',
    rawArchive: { append: async () => {} },
    profile: {
      enabled: true,
      profileId: 'gemini38',
      model,
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  const state = { writes: [], messages: [], releases: 0 };
  try {
    for await (const message of service.invoke('A', {
      invocationId,
      workingDirectory: workspace,
      ...(signal ? { signal } : {}),
      ...(registered
        ? {
            activeRunDispatch: {
              invocationId,
              register: (dispatcher) => {
                state.dispatcher = dispatcher;
                return () => {
                  state.releases++;
                };
              },
            },
          }
        : {}),
      spawnCliOverride: async function* (launch) {
        state.closed = () => launch.stdinCloseSignal.aborted;
        if (launch.stdinInput) state.writes.push(launch.stdinInput);
        launch.onStdinReady?.((body) => {
          assert.equal(state.closed(), false);
          state.writes.push(body);
        });
        yield {
          event: 'init',
          conversation_id: session,
          init: {
            agent: launch.args[launch.args.indexOf('--agent') + 1],
            cwd: launch.cwd,
            model,
            permission_mode: 'request-review',
            tools: [],
          },
        };
        yield* script(state);
      },
    })) {
      await onMessage?.(message);
      state.messages.push(message);
    }
    return state;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
