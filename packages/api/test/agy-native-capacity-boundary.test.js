import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agyCapacityFixture } from './helpers/agy-capacity-fixture.js';

const scenarios = [];
for (const earlierCheckpoint of [false, true])
  for (const failure of ['undeclared', 'transport', 'none'])
    for (const manual of [false, true]) scenarios.push({ earlierCheckpoint, failure, manual, third: false });
scenarios.push({ earlierCheckpoint: false, failure: 'none', manual: true, third: true });

for (const { earlierCheckpoint, failure, manual, third } of scenarios)
  test(`capacity belongs to its consumed turn (${earlierCheckpoint}, ${failure}, compact=${manual}, third=${third})`, async (t) => {
    const f = agyCapacityFixture(t);
    const service = f.makeService();
    let dispatcher;
    const completed = [];
    const step = (index, type, extra = {}) => ({
      event: 'step_update',
      step_update: {
        conversation_id: 'capacity-session',
        step_index: index,
        step_type: type,
        state: 'DONE',
        ...extra,
      },
    });
    const result = {
      event: 'result',
      result: { conversation_id: 'capacity-session', status: 'SUCCESS', response: 'Done', num_turns: 1 },
    };
    const events = await Array.fromAsync(
      service.invoke('first', {
        invocationId: 'capacity-multi',
        workingDirectory: f.workspace,
        activeRunDispatch: {
          invocationId: 'capacity-multi',
          register(value) {
            dispatcher = value;
            return () => {};
          },
        },
        spawnCliOverride: async function* (launch) {
          launch.onStdinReady(() => {});
          yield {
            event: 'init',
            conversation_id: 'capacity-session',
            init: {
              cwd: launch.cwd,
              agent: launch.args[launch.args.indexOf('--agent') + 1],
              model: f.model,
              permission_mode: 'always-proceed',
              tools: [],
            },
          };
          yield step(0, 'user_input');
          assert.equal(
            (
              await dispatcher.dispatch(
                {
                  text: manual ? '/compact' : 'second',
                  messageIds: ['second'],
                  onInputCompleted: async (ok) => {
                    completed.push(['B', ok]);
                  },
                },
                { expectedInvocationId: 'capacity-multi' },
              )
            ).accepted,
            true,
          );
          if (third)
            assert.equal(
              (
                await dispatcher.dispatch(
                  {
                    text: 'third',
                    messageIds: ['third'],
                    onInputCompleted: async (ok) => {
                      completed.push(['C', ok]);
                    },
                  },
                  { expectedInvocationId: 'capacity-multi' },
                )
              ).accepted,
              true,
            );
          if (earlierCheckpoint)
            yield step(1, 'checkpoint', { usage: { input_tokens: 0, cache_read_tokens: 511499, output_tokens: 0 } });
          yield step(2, 'agent_response', { text_delta: 'First done' });
          yield result;
          yield step(3, 'user_input');
          yield step(4, 'checkpoint', { usage: { input_tokens: 0, cache_read_tokens: 490000, output_tokens: 0 } });
          if (failure === 'undeclared')
            yield step(5, 'tool', { tool_name: 'unexpected_capacity_tool', tool_info: { output: 'fixture' } });
          yield step(6, 'agent_response', { text_delta: 'Second done' });
          yield result;
          if (third) {
            yield step(7, 'user_input');
            yield step(8, 'checkpoint', { usage: { input_tokens: 0, cache_read_tokens: 480000, output_tokens: 0 } });
            yield step(9, 'agent_response', { text_delta: 'Third done' });
            yield result;
          }
          if (failure === 'transport')
            yield {
              __cliError: true,
              message: 'fixture transport failed after second result',
              exitCode: 1,
              signal: null,
            };
        },
      }),
    );
    assert.equal(
      events.at(-1).errorCode,
      failure === 'undeclared' ? 'AGY_UNEXPECTED_TOOL' : failure === 'transport' ? 'AGY_NATIVE_FAILED' : undefined,
    );
    assert.deepEqual(
      completed,
      third
        ? [
            ['B', true],
            ['C', true],
          ]
        : [['B', failure === 'none']],
    );
    const next = await f.run(f.makeService());
    assert.equal(next.errorCode, undefined);
    assert.equal(
      next.metadata.contextWindowObservation?.windowTokens,
      third ? 480000 : failure === 'none' && !manual ? 490000 : earlierCheckpoint ? 511499 : undefined,
      'queued manual input cannot change A; manual B cannot mint evidence; normal C can observe its own checkpoint',
    );
  });
