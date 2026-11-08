import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';

const { projectAgyNativeTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js'
);
const { summarizeAgyStreamJsonTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'
);
const { verifiedInitSessionId } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-stream-validation.js'
);
const { materializeAgyNativeAgentFile } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js'
);

const options = { selfHost: () => ({ confidence: 'none' }) };

for (const tools of [
  undefined,
  ['view_file', 'read_file', 'write_to_file', 'write_file', 'replace_file_content', 'edit_file'],
]) {
  test(`agent components avoid CLI alias conflicts for ${tools ? 'mixed' : 'default read-only'} declarations`, () => {
    const home = mkdtempSync(join(tmpdir(), 'f325-files15-agent-'));
    try {
      const { filePath } = materializeAgyNativeAgentFile({
        profileHome: home,
        catId: 'gemini38',
        systemPrompt: 'Synthetic file capability qualification.\n',
        ...(tools ? { tools } : {}),
      });
      const components = [...readFileSync(filePath, 'utf8').matchAll(/^ {2}- (.+)$/gm)].map((match) => match[1]);
      assert.ok(components.includes('view_file'));
      assert.ok(!components.includes('read_file'));
      if (tools) assert.deepEqual(components, ['view_file', 'write_to_file', 'replace_file_content']);
      else assert.ok(!components.some((name) => /write|edit|run_command/.test(name)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

function guard(name, args, extra = {}) {
  return decideAgyNativeHookPayload({ toolCall: { name, args }, workspacePaths: ['/tmp'] }, { ...options, ...extra });
}
function project(name, parameters = { Path: '/tmp/ordinary.txt' }, declared, error) {
  const session = 'files15-session';
  const events = [
    { event: 'init', conversation_id: session, init: { agent: 'fixture' } },
    {
      event: 'step_update',
      step_update: { conversation_id: session, step_index: 0, state: 'DONE', step_type: 'user_input' },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: session,
        step_index: 1,
        state: error ? 'ERROR' : 'DONE',
        step_type: 'tool',
        tool_name: name,
        tool_info: { parameters, ...(error ? { error: { message: error } } : { output: 'fixture tool output' }) },
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: session,
        step_index: 2,
        state: 'DONE',
        step_type: 'agent_response',
        text: 'Complete fixture answer.',
      },
    },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Complete fixture answer.' } },
  ];
  return projectAgyNativeTurn(
    'gemini38',
    { provider: 'google', model: 'gemini-4-argon-high' },
    { sessionId: session, turn: summarizeAgyStreamJsonTurn(events.map(JSON.stringify)), transportError: null },
    false,
    declared,
  );
}

for (const [name, args] of [
  ['read_file', { Path: '/tmp/ordinary.txt' }],
  ['write_file', { Path: '/tmp/ordinary.txt', Content: 'ordinary' }],
  ['edit_file', { Path: '/tmp/ordinary.txt', Target: 'a', Replacement: 'b' }],
]) {
  test(`AGY 1.5 ${name} accepts ordinary local operations`, () => {
    assert.equal(guard(name, args).decision, 'allow');
  });
  test(`AGY 1.5 ${name} remains the observed tool in a successful carrier turn`, () => {
    const messages = project(name, args);
    assert.equal(messages.at(-1).errorCode, undefined);
    const use = messages.find((m) => m.type === 'tool_use');
    assert.equal(use.toolName, name);
    assert.deepEqual(use.toolInput, args);
    assert.equal(messages.find((m) => m.type === 'tool_result').toolResultStatus, 'ok');
  });
}

test('modern reads remain available to read-only invocations; writes and unknown tools do not', () => {
  assert.equal(guard('read_file', { Path: '/tmp/file' }, { readOnly: true }).decision, 'allow');
  for (const name of ['write_file', 'edit_file', 'future_native_tool'])
    assert.equal(guard(name, { Path: '/tmp/file', Content: 'x' }, { readOnly: true }).decision, 'deny');
});

for (const name of ['write_file', 'edit_file']) {
  test(`${name} protects the real Path even if a legacy target field points elsewhere`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-files15-control-')));
    try {
      const profile = join(root, 'profile');
      mkdirSync(join(profile, '.gemini/config'), { recursive: true });
      const Path = join(profile, '.gemini/config/hooks.json');
      assert.equal(
        guard(
          name,
          { Path, TargetFile: join(root, 'ordinary.txt'), Content: 'x', Target: 'a', Replacement: 'b' },
          { profileHome: profile },
        ).decision,
        'deny',
      );
      assert.equal(
        guard(name, {
          Path: join(root, 'cat-cafe-runtime/packages/api/src/index.ts'),
          TargetFile: join(root, 'ordinary.txt'),
        }).decision,
        'deny',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test(`${name} requires its own valid Path, never a legacy-field fallback`, () => {
    for (const Path of [undefined, '', false, ['file']])
      assert.equal(guard(name, { Path, TargetFile: '/tmp/ordinary.txt', Content: 'x' }).decision, 'deny');
  });
}

test('a file capability alias does not grant an undeclared writer or an arbitrary tool', () => {
  assert.equal(project('read_file', undefined, ['view_file']).at(-1).errorCode, undefined);
  for (const [name, declared] of [
    ['write_file', ['view_file']],
    ['read_file', []],
    ['read_file', ['call_mcp_tool']],
    ['future_native_tool', ['view_file']],
  ])
    assert.equal(project(name, undefined, declared).at(-1).errorCode, 'AGY_UNEXPECTED_TOOL');
});

test('explicit modern declarations accept only their matching legacy spelling', () => {
  assert.equal(project('view_file', { AbsolutePath: '/tmp/file' }, ['read_file']).at(-1).errorCode, undefined);
  assert.equal(
    project('write_to_file', { TargetFile: '/tmp/file' }, ['read_file']).at(-1).errorCode,
    'AGY_UNEXPECTED_TOOL',
  );
});

test('modern init vocabulary is qualified, while unrecognized operations still fail closed', () => {
  const expected = { agentName: 'fixture', spawnCwd: '/tmp', model: 'gemini-4-argon-high' };
  const envelope = {
    conversation_id: 'files15',
    init: {
      agent: expected.agentName,
      cwd: expected.spawnCwd,
      model: expected.model,
      permission_mode: 'request-review',
      tools: ['read_file', 'write_file', 'edit_file'],
    },
  };
  assert.equal(verifiedInitSessionId(envelope, expected, false), 'files15');
  assert.throws(
    () =>
      verifiedInitSessionId(
        { ...envelope, init: { ...envelope.init, tools: ['future_native_tool'] } },
        expected,
        false,
      ),
    /unqualified tool/,
  );
});

for (const error of ['File not found', 'file does not exist']) {
  test(`a missing modern file preserves its error and read-observation metadata: ${error}`, () => {
    const messages = project('read_file', { Path: '/tmp/not-there' }, undefined, error);
    assert.equal(messages.at(-1).errorCode, undefined);
    assert.equal(messages.find((m) => m.type === 'tool_result').toolResultStatus, 'error');
    assert.equal(messages.find((m) => m.type === 'tool_result').content, error);
    assert.deepEqual(messages.at(-1).metadata.diagnostics.agyNative.readObservations, [
      { stepIndex: 1, toolName: 'read_file', outcome: 'not_found' },
    ]);
  });
}

test('legacy file names keep their existing behavior', () => {
  for (const [name, args] of [
    ['view_file', { AbsolutePath: '/tmp/ordinary.txt' }],
    ['write_to_file', { TargetFile: '/tmp/ordinary.txt', CodeContent: 'x' }],
    ['replace_file_content', { TargetFile: '/tmp/ordinary.txt', TargetContent: 'x', ReplacementContent: 'y' }],
  ]) {
    assert.equal(guard(name, args).decision, 'allow');
    assert.equal(project(name, args).at(-1).errorCode, undefined);
  }
});
