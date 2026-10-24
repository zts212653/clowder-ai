import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { deriveResultSummary } from '../dist/domains/cats/services/tool-usage/derive-result-summary.js';

const model = 'gemini-3.8-flash-high';
const session = 'spill-fixture-session';
const toolName = 'mcp:cat-cafe-memory/cat_cafe_search_evidence';
const recovered = `\uFEFFEvidence search results: Found 5 result(s) for 线程概况\n${'recorded fixture output\n'.repeat(400)}<recall-meta>{"resultStatus":"counted","resultCount":5}</recall-meta>`;
const parameters = {
  ServerName: 'cat-cafe-memory',
  ToolName: 'cat_cafe_search_evidence',
  Arguments: { query: 'fixture' },
};
const spillPath = (home, conversation = session, index = 37) =>
  join(home, '.gemini/antigravity-cli/brain', conversation, '.system_generated/steps', String(index), 'output.txt');

async function runFixture({
  prepare,
  internalTurn = false,
  inline,
  state = 'DONE',
  nativeName = 'call_mcp_tool',
  terminalConversation = session,
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-mcp-spill-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const messages = [];
  const archived = [];
  let beforeFinal;
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    l0CompilerFn: async () => '# Native fixture',
    rawArchive: { append: async (_id, event) => archived.push(JSON.stringify(event)) },
    profile: {
      enabled: true,
      profileId: 'gemini38',
      model,
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  try {
    for await (const message of service.invoke('Read the fixture output.', {
      invocationId: 'spill-fixture',
      workingDirectory: workspace,
      ...(internalTurn ? { activeRunDispatch: { invocationId: 'spill-fixture', register: () => {} } } : {}),
      spawnCliOverride: async function* (launch) {
        launch.onStdinReady?.(() => {});
        yield {
          event: 'init',
          conversation_id: session,
          init: {
            agent: launch.args[launch.args.indexOf('--agent') + 1],
            cwd: launch.cwd,
            model,
            permission_mode: 'request-review',
          },
        };
        yield {
          event: 'step_update',
          step_update: { conversation_id: session, step_index: 0, step_type: 'user_input', state: 'DONE' },
        };
        // The official MCP ACTIVE event can lack parameters until the terminal update.
        yield {
          event: 'step_update',
          step_update: {
            conversation_id: session,
            step_index: 37,
            step_type: 'tool',
            state: 'ACTIVE',
            tool_name: nativeName,
            tool_info: {},
          },
        };
        const home = launch.env.HOME;
        await prepare?.({ root, home, path: spillPath(home) });
        yield {
          event: 'step_update',
          step_update: {
            conversation_id: terminalConversation,
            step_index: 37,
            step_type: 'tool',
            state,
            tool_name: nativeName,
            tool_info: {
              name: nativeName,
              parameters,
              ...(inline !== undefined ? { output: inline } : {}),
              ...(state === 'ERROR' ? { error: { message: 'fixture denied' } } : {}),
            },
          },
        };
        beforeFinal = messages.filter((message) => message.type === 'tool_result');
        yield { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Read complete.' } };
      },
    }))
      messages.push(message);
    return { messages, archived, beforeFinal };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const writeOutput = ({ path }, content = recovered) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

for (const internalTurn of [false, true]) {
  test(`Native ${internalTurn ? 'internal-turn' : 'ordinary'} MCP spill reaches live result and recall count without rewriting raw evidence`, async () => {
    const result = await runFixture({ internalTurn, prepare: writeOutput });
    const toolResults = result.messages.filter((message) => message.type === 'tool_result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].toolName, toolName);
    assert.equal(toolResults[0].toolUseId, `${session}:37`);
    assert.equal(toolResults[0].content, recovered);
    assert.equal(toolResults[0].toolResultStatus, 'ok');
    assert.equal(deriveResultSummary('search_evidence', toolResults[0].content).resultCount, 5);
    assert.equal(result.beforeFinal?.[0]?.content, recovered, 'output must be available before the final response');
    assert.equal(
      result.messages.some((message) => message.type === 'error'),
      false,
    );
    const originalTerminal = result.archived
      .map((line) => JSON.parse(line))
      .find((event) => event.step_update?.step_index === 37 && event.step_update.state === 'DONE');
    assert.equal(Object.hasOwn(originalTerminal.step_update.tool_info, 'output'), false);
  });
}

test('inline MCP output remains authoritative even when a step file exists', async () => {
  const { messages } = await runFixture({ inline: 'inline result', prepare: writeOutput });
  assert.equal(messages.find((message) => message.type === 'tool_result')?.content, 'inline result');
});

for (const kind of ['absent', 'other step', 'other conversation', 'explicit empty']) {
  test(`Native does not invent a recall count for ${kind} output`, async () => {
    const { messages } = await runFixture({
      ...(kind === 'explicit empty' ? { inline: '' } : {}),
      prepare: ({ home, path }) => {
        if (kind === 'absent') return;
        if (kind === 'other step') path = spillPath(home, session, 38);
        if (kind === 'other conversation') path = spillPath(home, 'another-session');
        writeOutput({ path });
      },
    });
    const result = messages.find((message) => message.type === 'tool_result');
    assert.equal(result?.content, '');
    assert.deepEqual(deriveResultSummary('search_evidence', result.content), {});
  });
}

for (const variant of ['error', 'builtin', 'foreign terminal']) {
  test(`Native does not use a spill file to repair ${variant} evidence`, async () => {
    const { messages } = await runFixture({
      prepare: writeOutput,
      ...(variant === 'error' ? { state: 'ERROR' } : {}),
      ...(variant === 'builtin' ? { nativeName: 'view_file' } : {}),
      ...(variant === 'foreign terminal' ? { terminalConversation: 'another-session' } : {}),
    });
    assert.equal(
      messages.some((message) => message.content?.includes('recorded fixture output')),
      false,
    );
    if (variant === 'error')
      assert.equal(messages.find((message) => message.type === 'tool_result')?.toolResultStatus, 'error');
  });
}

for (const variant of ['leaf symlink', 'parent symlink', 'hard link', 'directory', 'oversized', 'invalid utf8']) {
  test(`Native never exposes unsafe ${variant} spill content`, async () => {
    const secret = 'OUTSIDE_PROFILE_SENTINEL';
    const { messages } = await runFixture({
      prepare: ({ root, path }) => {
        mkdirSync(dirname(path), { recursive: true });
        if (['leaf symlink', 'parent symlink', 'hard link'].includes(variant)) {
          const outside = join(root, 'outside');
          mkdirSync(outside);
          writeFileSync(join(outside, 'output.txt'), secret);
          if (variant === 'leaf symlink') symlinkSync(join(outside, 'output.txt'), path);
          else if (variant === 'hard link') linkSync(join(outside, 'output.txt'), path);
          else {
            rmSync(dirname(path), { recursive: true });
            symlinkSync(outside, dirname(path), process.platform === 'win32' ? 'junction' : 'dir');
          }
        } else if (variant === 'directory') mkdirSync(path);
        else if (variant === 'oversized') {
          writeFileSync(path, secret);
          truncateSync(path, 8 * 1024 * 1024 + 1);
        } else writeFileSync(path, Buffer.from([0xff, ...Buffer.from(secret)]));
      },
    });
    assert.equal(
      messages.some((message) => message.content?.includes(secret)),
      false,
    );
    assert.ok(messages.some((message) => message.type === 'error' && /step output file/.test(message.error)));
    assert.ok(messages.find((message) => message.type === 'done')?.errorCode);
  });
}
