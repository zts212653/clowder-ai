import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyNativeAgentService } from '../../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';

export function agyCapacityFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-capacity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const command = join(root, 'agy-fixture');
  const setVersion = (version) => {
    writeFileSync(
      command,
      `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(2);\nconsole.log('AGY CLI version ${version}');\n`,
    );
    chmodSync(command, 0o700);
  };
  setVersion('1.5.9');
  const model = 'gemini-4-carbon-high';
  const setGrant = (grant) => {
    const path = join(root, 'profiles/fixture/.gemini/antigravity-cli/antigravity-oauth-token');
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ auth_method: 'consumer', token: { refresh_token: grant } }), { mode: 0o600 });
  };
  setGrant('synthetic-refresh-grant-A');
  const makeService = (patch = {}) =>
    new AgyNativeAgentService({
      catId: 'gemini-carbon',
      command,
      profile: {
        enabled: true,
        autoApprove: true,
        profileId: 'fixture',
        homeRoot: join(root, 'profiles'),
        model,
        ...patch,
      },
      l0CompilerFn: async () => '# Identity\nCapacity fixture.\n',
      rawArchive: { append: async () => {} },
    });
  const run = async (
    service,
    {
      checkpoint = false,
      state = 'DONE',
      tokens = 511499,
      prompt = 'hello',
      error = false,
      failure,
      reasoningEffortOverride,
      signal,
    } = {},
  ) => {
    const events = [];
    for await (const message of service.invoke(prompt, {
      workingDirectory: workspace,
      reasoningEffortOverride,
      signal,
      spawnCliOverride: async function* (launch) {
        const selectedModel = launch.args[launch.args.indexOf('--model') + 1];
        yield {
          event: 'init',
          conversation_id: 'capacity-session',
          init: {
            cwd: launch.cwd,
            agent: launch.args[launch.args.indexOf('--agent') + 1],
            model: selectedModel,
            permission_mode: 'always-proceed',
            tools: [],
          },
        };
        if (checkpoint)
          yield {
            event: 'step_update',
            step_update: {
              conversation_id: 'capacity-session',
              step_index: 1,
              step_type: 'checkpoint',
              state,
              usage: { input_tokens: 0, cache_read_tokens: tokens, output_tokens: 0 },
            },
          };
        if (failure === 'undeclared')
          yield {
            event: 'step_update',
            step_update: {
              conversation_id: 'capacity-session',
              step_index: 3,
              step_type: 'tool',
              state: 'DONE',
              tool_name: 'unexpected_capacity_tool',
              tool_info: { output: 'completed fixture' },
            },
          };
        yield {
          event: 'step_update',
          step_update: {
            conversation_id: 'capacity-session',
            step_index: 2,
            step_type: 'agent_response',
            state: 'DONE',
            text_delta: 'Done',
            usage: { input_tokens: 100, cache_read_tokens: 35000, output_tokens: 1 },
          },
        };
        yield {
          event: 'result',
          result: {
            conversation_id: 'capacity-session',
            status: error ? 'ERROR' : 'SUCCESS',
            response: 'Done',
            ...(error ? { error: 'fixture failed' } : {}),
            num_turns: 1,
          },
        };
        if (failure === 'transport')
          yield {
            __cliError: true,
            message: 'fixture transport failed after result',
            exitCode: 1,
            signal: null,
          };
      },
    }))
      events.push(message);
    return events.at(-1);
  };
  return { root, command, model, workspace, makeService, run, setVersion, setGrant };
}
