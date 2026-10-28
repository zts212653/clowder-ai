import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { nativeHookTestEnv } from './helpers/native-hook-programs.js';

const guardPath = fileURLToPath(new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url));
const noSelfHost = { selfHost: () => ({ confidence: 'none' }) };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'f306-final-payload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ordinary = join(root, 'ordinary');
  const runtime = join(root, 'cat-cafe-runtime');
  for (const directory of [ordinary, runtime]) mkdirSync(directory);
  return { ordinary, runtime };
}

function payload(cwd, nativeCwd, phase = 'before_first_effect') {
  return {
    session_id: 'session-final-payload',
    turn_id: 'turn-final-payload',
    tool_use_id: 'call-final-payload',
    hook_event_name: 'NativeShellSafetyCheck',
    tool_name: 'Bash',
    cwd,
    native_execution: {
      plan_id: 'plan-final-payload',
      call_id: 'call-final-payload',
      turn_id: 'turn-final-payload',
      environment_id: 'local',
      cwd_uri: pathToFileURL(nativeCwd).href,
      argv: ['/bin/bash', '-c', 'printf owned > effect.txt'],
      command: 'printf owned > effect.txt',
      phase,
      constraints: {},
      fingerprint: 'a'.repeat(40),
    },
  };
}

function opaqueLocalPayload(t) {
  const { ordinary } = fixture(t);
  const input = payload(ordinary, ordinary);
  // Rust PathUri::from_opaque_path_bytes uses URL_SAFE_NO_PAD for native bytes.
  const nativePath = Buffer.concat([
    Buffer.from('/tmp/nonutf8-'),
    Buffer.from([0xff]),
    Buffer.from('/cat-cafe-runtime'),
  ]);
  input.native_execution.cwd_uri = `file:///%00/bad/path/${nativePath.toString('base64url')}`;
  return input;
}

test('opaque local PathUri cannot become an ordinary executor coordinate', (t) => {
  const input = opaqueLocalPayload(t);
  assert.ok(fileURLToPath(input.native_execution.cwd_uri).includes('\0'), 'Node decodes the carrier without throwing');
  const decision = decideNativeHookPayload(input, noSelfHost);
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'invalid_native_shell_execution');
});

test('opaque local PathUri CLI returns an explicit fingerprint-bound Native deny', (t) => {
  const input = opaqueLocalPayload(t);
  const result = spawnSync(process.execPath, [guardPath], {
    env: nativeHookTestEnv(),
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'deny');
  assert.equal(output.fingerprint, input.native_execution.fingerprint);
  assert.deepEqual(Object.keys(output).sort(), ['decision', 'fingerprint', 'reason']);
  assert.match(output.reason, /invalid_native_shell_execution/);
});

for (const phase of ['before_first_effect', 'launch']) {
  test(`${phase}: runtime hook cwd does not contaminate an ordinary executor coordinate`, (t) => {
    const { ordinary, runtime } = fixture(t);
    const decision = decideNativeHookPayload(payload(runtime, ordinary, phase), noSelfHost);
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.effect, 'write');
    assert.equal(decision.source.cwd, ordinary);
  });

  test(`${phase}: ordinary hook cwd does not hide a protected executor coordinate`, (t) => {
    const { ordinary, runtime } = fixture(t);
    const decision = decideNativeHookPayload(payload(ordinary, runtime, phase), noSelfHost);
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.target.kind, 'runtime_sanctuary');
    assert.equal(decision.source.cwd, runtime);
  });
}

const invalidInputs = [
  ['missing executor facts', (input) => delete input.native_execution],
  [
    'mismatched call',
    (input) => {
      input.native_execution.call_id = 'another-call';
    },
  ],
  [
    'mismatched turn',
    (input) => {
      input.native_execution.turn_id = 'another-turn';
    },
  ],
  [
    'unattested remote URI',
    (input) => {
      input.native_execution.cwd_uri = 'ssh://remote.example/work';
    },
  ],
  [
    'URI query',
    (input) => {
      input.native_execution.cwd_uri += '?other-coordinate';
    },
  ],
  [
    'decoded NUL outside the opaque namespace',
    (input) => {
      input.native_execution.cwd_uri = 'file:///tmp/other%00/cat-cafe-runtime';
    },
  ],
  [
    'non-UTF-8 URI bytes that Node cannot decode',
    (input) => {
      input.native_execution.cwd_uri = 'file:///tmp/nonutf8-%FF/cat-cafe-runtime';
    },
  ],
  [
    'unsupported phase',
    (input) => {
      input.native_execution.phase = 'cached';
    },
  ],
  [
    'generic prepared phase',
    (input) => {
      input.native_execution.phase = 'prepared';
    },
  ],
  [
    'non-shell event',
    (input) => {
      input.tool_name = 'Write';
    },
  ],
  [
    'empty argv',
    (input) => {
      input.native_execution.argv = [];
    },
  ],
  [
    'nonlocal environment',
    (input) => {
      input.native_execution.environment_id = 'devbox';
    },
  ],
  [
    'unexpected tool input',
    (input) => {
      input.tool_input = { command: 'echo forged' };
    },
  ],
];

for (const [name, corrupt] of invalidInputs) {
  test(`enabled Native final input rejects ${name} rather than using the hook cwd`, (t) => {
    const { ordinary } = fixture(t);
    const input = payload(ordinary, ordinary);
    corrupt(input);
    assert.equal(decideNativeHookPayload(input, noSelfHost).decision, 'deny');
  });
}

test('PreToolUse never trusts a model-shaped native_execution object', (t) => {
  const { ordinary, runtime } = fixture(t);
  const input = payload(runtime, ordinary);
  input.hook_event_name = 'PreToolUse';
  input.tool_input = { command: 'printf owned > effect.txt' };
  const decision = decideNativeHookPayload(input, noSelfHost);
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.source.cwd, runtime);
});

test('existing Edit/Write file protection is retained', (t) => {
  const { ordinary, runtime } = fixture(t);
  for (const tool_name of ['Edit', 'Write']) {
    const decision = decideNativeHookPayload(
      {
        hook_event_name: 'PreToolUse',
        turn_id: 'legacy-turn',
        tool_name,
        cwd: ordinary,
        tool_input: { file_path: join(runtime, 'protected.txt') },
      },
      noSelfHost,
    );
    assert.equal(decision.decision, 'deny');
  }
});

test('constraint declarations never turn protected writes into permission grants', (t) => {
  const { ordinary, runtime } = fixture(t);
  const input = payload(ordinary, runtime);
  input.native_execution.constraints = { read_only: true, network_disabled: true };
  assert.equal(decideNativeHookPayload(input, noSelfHost).decision, 'deny');
});

for (const expected of ['accept', 'deny']) {
  test(`Native CLI emits a bound ${expected} without permission output`, (t) => {
    const { ordinary, runtime } = fixture(t);
    const input = payload(ordinary, expected === 'accept' ? ordinary : runtime);
    const result = spawnSync(process.execPath, [guardPath], {
      env: nativeHookTestEnv(),
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\s*\{/, 'enabled Native check must return an explicit verdict');
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, expected);
    assert.equal(output.fingerprint, input.native_execution.fingerprint);
    assert.deepEqual(
      Object.keys(output).sort(),
      expected === 'accept' ? ['decision', 'fingerprint'] : ['decision', 'fingerprint', 'reason'],
    );
    if (expected === 'deny') assert.ok(output.reason.length > 0);
  });
}
