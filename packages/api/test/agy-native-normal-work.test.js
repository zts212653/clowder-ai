import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { projectAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { summarizeAgyStreamJsonTurn } from '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js';

const model = 'gemini-3.8-flash-high';

test('Native exposes verified init while the real provider iterator is still running', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f325-visible-work-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  let releaseProvider;
  let reachedProviderBarrier;
  const release = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const barrier = new Promise((resolve) => {
    reachedProviderBarrier = resolve;
  });
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(root, 'profiles'),
      model,
      trustedWorkspaces: [workspace],
    },
    l0CompilerFn: async () => '# Identity\nYou are gemini38.\n',
  });
  const iterator = service.invoke('Read the project and explain it.', {
    workingDirectory: workspace,
    spawnCliOverride: async function* (launch) {
      yield {
        event: 'init',
        conversation_id: 'visible-session',
        init: {
          agent: launch.args[launch.args.indexOf('--agent') + 1],
          cwd: launch.cwd,
          model,
          permission_mode: 'request-review',
        },
      };
      reachedProviderBarrier();
      await release;
      yield {
        event: 'result',
        result: { conversation_id: 'visible-session', status: 'SUCCESS', response: 'Read complete.' },
      };
    },
  });
  const first = iterator.next();
  try {
    const visible = await Promise.race([first.then((step) => step.value), barrier.then(() => null)]);
    assert.equal(
      visible?.type,
      'session_init',
      'init must reach the host before provider completion, including a later Stop',
    );
  } finally {
    releaseProvider();
    await first;
    for await (const _event of iterator) {
      /* drain and prove service cleanup */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function toolStep(index, toolName, parameters, error) {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: 'work-session',
      step_index: index,
      step_type: 'tool',
      state: error ? 'ERROR' : 'DONE',
      tool_name: toolName,
      tool_info: { parameters, ...(error ? { error: { message: error } } : { output: 'success' }) },
    },
  };
}

for (const scenario of [
  {
    name: 'a failing test followed by its repair',
    tool: 'run_command',
    parameters: { CommandLine: 'node --test task.test.mjs', Cwd: '/project' },
    error: 'exit status 1',
    grants: [],
    tools: ['run_command'],
  },
  {
    name: 'a recoverable MCP argument error followed by a corrected read',
    tool: 'call_mcp_tool',
    parameters: {
      ServerName: 'cat-cafe-memory',
      ToolName: 'cat_cafe_search_evidence',
      Arguments: { query: 'known topic' },
    },
    error: 'Invalid request: query is required',
    grants: ['cat-cafe-memory/cat_cafe_search_evidence'],
    tools: [],
  },
]) {
  test(`Native preserves ${scenario.name} as tool history and delivers the final`, () => {
    const finalText = 'The first attempt failed; I corrected it and the second attempt succeeded.';
    const turn = summarizeAgyStreamJsonTurn(
      [
        toolStep(1, scenario.tool, scenario.parameters, scenario.error),
        toolStep(2, scenario.tool, scenario.parameters),
        { event: 'result', result: { conversation_id: 'work-session', status: 'SUCCESS', response: finalText } },
      ].map((frame) => JSON.stringify(frame)),
    );
    const messages = projectAgyNativeTurn(
      'gemini38',
      { provider: 'google', model },
      {
        sessionId: 'work-session',
        turn,
        transportError: null,
      },
      false,
      scenario.tool === 'call_mcp_tool' ? ['call_mcp_tool'] : scenario.tools,
    );
    assert.equal(messages.find((message) => message.type === 'text')?.content, finalText);
    assert.deepEqual(
      messages.filter((message) => message.type === 'tool_result').map((message) => message.toolResultStatus),
      ['error', 'ok'],
    );
    assert.equal(messages.at(-1).errorCode, undefined, 'a handled tool error must not be promoted to carrier failure');
  });
}
