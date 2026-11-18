import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import {
  buildAgyDataReceiverCommand,
  readAgyDataInputContract,
} from '../../../scripts/lib/agy-data-input-contract.mjs';

const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

test('Native refuses input to owned wrapped tasks without a data-input permission', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-input-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileHome = join(root, 'profile');
  mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
  const options = { workspaceRoot: root, profileHome };
  const commands = ['env -i bash', 'env -u NAME bash', 'exec -a task bash', 'nice -n 10 bash', 'env -S "bash -i"'];
  for (const [stepIdx, command] of commands.entries()) {
    const callId = `call-${stepIdx}`;
    const taskId = `owned-conversation/task-${stepIdx}`;
    const payload = {
      conversationId: 'owned-conversation',
      stepIdx,
      workspacePaths: [root],
      toolCall: { id: callId, name: 'run_command', args: { CommandLine: command } },
    };
    assert.equal(decideAgyNativeHookPayload(payload, options).decision, 'allow', command);
    decideAgyNativeHookPayload({ ...payload, hookEventName: 'PostToolUse', output: `task id: ${taskId}` }, options);
    for (const toolCall of [
      { name: 'send_command_input', args: { CommandId: taskId, Input: 'redis-cli -p 6399 FLUSHALL\n' } },
      { name: 'manage_task', args: { Action: 'send_input', TaskId: taskId, Input: 'redis-cli -p 6399 FLUSHALL\n' } },
    ]) {
      const result = decideAgyNativeHookPayload({ ...payload, toolCall }, options);
      assert.equal(result.decision, 'deny', `${command}: ${toolCall.name} has no data-input permission`);
    }
  }
});

test('Native task classification requires a known data source rather than assuming unknown executables are safe', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-input-contract-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = buildAgyDataReceiverCommand();
  for (const candidate of command ? [command] : []) {
    assert.notEqual(readAgyDataInputContract(candidate, root), null, candidate);
  }
  for (const command of [
    'env --unmodeled bash',
    'env -u',
    'bash --rcfile profile',
    'python -X dev',
    'node --require helper.js',
    'node -i scripts/prompt-task.js',
    'env -i "$INTERPRETER"',
    'bash -',
    'bash /dev/stdin',
    'python3 /dev/fd/0',
    'node /proc/self/fd/0',
    'python3.11',
    'python3.12',
    'perl',
    'unknown-input-executor',
    'node missing-script.js',
    '/usr/bin/env -i /usr/bin/head -c 9',
    'exec /usr/bin/head -c 9 file.txt',
    'exec /usr/bin/head -c 9; node',
    'exec /usr/bin/head -c 9 | node',
    'exec /usr/bin/head -c 9 > file.txt',
    'exec /usr/bin/head -c $BYTES',
  ]) {
    assert.equal(readAgyDataInputContract(command, root), null, command);
  }
});

test('Native task input rechecks a legacy non-interactive classification against the approved command', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-legacy-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileHome = join(root, 'profile');
  mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
  const options = { workspaceRoot: root, profileHome };
  const payload = {
    conversationId: 'legacy-conversation',
    stepIdx: 1,
    workspacePaths: [root],
    toolCall: { id: 'call-legacy', name: 'run_command', args: { CommandLine: 'env -i bash' } },
  };
  assert.equal(decideAgyNativeHookPayload(payload, options).decision, 'allow');
  decideAgyNativeHookPayload(
    { ...payload, hookEventName: 'PostToolUse', output: 'task id: legacy-conversation/task-1' },
    options,
  );
  const file = join(profileHome, '.gemini/config/.cat-cafe-command-ledger.json');
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      entries: [
        {
          conversationId: 'legacy-conversation',
          stepIdx: 1,
          taskId: 'legacy-conversation/task-1',
          cwd: root,
          command: 'env -i bash',
          interactiveRepl: false,
        },
      ],
    }),
  );
  const result = decideAgyNativeHookPayload(
    {
      ...payload,
      toolCall: {
        name: 'send_command_input',
        args: { CommandId: 'legacy-conversation/task-1', Input: 'redis-cli -p 6399 FLUSHALL\n' },
      },
    },
    options,
  );
  assert.equal(result.decision, 'deny', 'the persisted derived flag cannot authorize code input');
});

test('Native code tasks reject fragmented and context-dependent stdin while bound data tasks still accept input', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-stdin-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileHome = join(root, 'profile');
  mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
  const options = { workspaceRoot: root, profileHome };
  const dataCommand = buildAgyDataReceiverCommand();
  for (const [stepIdx, command] of ['bash', ...(dataCommand ? [dataCommand] : [])].entries()) {
    const taskId = `stdin-context/task-${stepIdx}`;
    const payload = {
      conversationId: 'stdin-context',
      stepIdx,
      workspacePaths: [root],
      toolCall: { id: `call-${stepIdx}`, name: 'run_command', args: { CommandLine: command } },
    };
    assert.equal(decideAgyNativeHookPayload(payload, options).decision, 'allow');
    decideAgyNativeHookPayload({ ...payload, hookEventName: 'PostToolUse', output: `task id: ${taskId}` }, options);
    for (const name of ['send_command_input', 'manage_task']) {
      const input = (text) =>
        decideAgyNativeHookPayload(
          {
            ...payload,
            toolCall: {
              name,
              args:
                name === 'send_command_input'
                  ? { CommandId: taskId, Input: text }
                  : { Action: 'send_input', TaskId: taskId, Input: text },
            },
          },
          options,
        );
      if (command === 'bash') {
        for (const chunk of ['redis-cli -p 63', '99 FLUSHALL\n', 'printf safe\n', 'cd /\n', '\n', ' \t']) {
          assert.equal(
            input(chunk).decision,
            'deny',
            `${name}: isolated chunk checks cannot certify ${JSON.stringify(chunk)}`,
          );
        }
        assert.equal(input('').decision, 'allow', 'zero bytes cannot extend the pending interpreter input');
      } else {
        assert.equal(input('continue\n').decision, 'allow', `${name}: approved bounded receivers remain usable`);
      }
    }
  }
});

test('Native rejects versioned and unknown stdin executors instead of granting them a data contract', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-unknown-stdin-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileHome = join(root, 'profile');
  mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
  const options = { workspaceRoot: root, profileHome };
  for (const [stepIdx, command] of ['python3.11', 'python3.12', 'perl', 'unknown-input-executor'].entries()) {
    const taskId = `unknown-stdin/task-${stepIdx}`;
    const payload = {
      conversationId: 'unknown-stdin',
      stepIdx,
      workspacePaths: [root],
      toolCall: { id: `call-${stepIdx}`, name: 'run_command', args: { CommandLine: command } },
    };
    assert.equal(decideAgyNativeHookPayload(payload, options).decision, 'allow');
    decideAgyNativeHookPayload({ ...payload, hookEventName: 'PostToolUse', output: `task id: ${taskId}` }, options);
    for (const name of ['send_command_input', 'manage_task']) {
      const input = '__import__("os").system("redis-cli -p 6399 FLUSHALL")\n';
      const result = decideAgyNativeHookPayload(
        {
          ...payload,
          toolCall: {
            name,
            args:
              name === 'send_command_input'
                ? { CommandId: taskId, Input: input }
                : { Action: 'send_input', TaskId: taskId, Input: input },
          },
        },
        options,
      );
      assert.equal(result.decision, 'deny', `${name}: ${command} has no data-input evidence`);
    }
  }
});

test(
  'Native binds data to a reviewed bounded consumer and its real process treats code-shaped bytes as data',
  { timeout: 10000, skip: !buildAgyDataReceiverCommand() },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-real-prompt-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const profileHome = join(root, 'profile');
    mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
    const options = { workspaceRoot: root, profileHome };
    const data = 'process.stdout.write("NOT-EXECUTED")\n';
    const bytes = Buffer.byteLength(data);
    const command = buildAgyDataReceiverCommand(bytes);
    const payload = {
      conversationId: 'real-prompt',
      stepIdx: 1,
      workspacePaths: [root],
      toolCall: { id: 'prompt-call', name: 'run_command', args: { CommandLine: command } },
    };
    assert.equal(decideAgyNativeHookPayload(payload, options).decision, 'allow');
    decideAgyNativeHookPayload(
      { ...payload, hookEventName: 'PostToolUse', output: 'task id: real-prompt/task-1' },
      options,
    );
    const input = () =>
      decideAgyNativeHookPayload(
        {
          ...payload,
          toolCall: {
            name: 'send_command_input',
            args: { CommandId: 'real-prompt/task-1', Input: data },
          },
        },
        options,
      );
    assert.equal(input().decision, 'allow');
    const child = spawn('/usr/bin/head', ['-c', String(bytes)], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    t.after(() => clearTimeout(timer));
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const closed = once(child, 'close');
    await once(child, 'spawn');
    child.stdin.end(data);
    assert.equal((await closed)[0], 0);
    assert.equal(output, data, 'received bytes are echoed rather than evaluated');
    const db = new DatabaseSync(join(profileHome, '.gemini/config/.cat-cafe-command-ledger.sqlite'));
    try {
      const row = db.prepare('SELECT id, command_json FROM approved_commands').get();
      const approval = JSON.parse(row.command_json);
      approval.command = `${quote(process.execPath)} -e 'eval(process.stdin.read())'`;
      db.prepare('UPDATE approved_commands SET command_json=? WHERE id=?').run(JSON.stringify(approval), row.id);
    } finally {
      db.close();
    }
    assert.equal(input().decision, 'deny', 'a different executable cannot borrow the data consumer receipt');
  },
);

test('an unchanged running script that interprets stdin cannot mint its own data-input permission', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-input-initial-eval-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileHome = join(root, 'profile');
  mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
  const script = join(root, 'input-code.cjs');
  const source = "let code='';process.stdin.on('data',d=>{code+=d;if(code.endsWith('\\n'))eval(code);});";
  writeFileSync(script, source);
  const options = { workspaceRoot: root, profileHome };
  const payload = {
    conversationId: 'initial-eval',
    stepIdx: 1,
    workspacePaths: [root],
    toolCall: {
      id: 'eval-call',
      name: 'run_command',
      args: {
        CommandLine: `${quote(process.execPath)} ${quote(script)}`,
      },
    },
  };
  assert.equal(decideAgyNativeHookPayload(payload, options).decision, 'allow');
  decideAgyNativeHookPayload(
    { ...payload, hookEventName: 'PostToolUse', output: 'task id: initial-eval/task-1' },
    options,
  );
  const child = spawn(process.execPath, [script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await once(child, 'spawn');
  for (const chunk of ['process.stdout.', 'write("UNEXPECTED-EXECUTION")\n']) {
    const result = decideAgyNativeHookPayload(
      {
        ...payload,
        toolCall: {
          name: 'send_command_input',
          args: { CommandId: 'initial-eval/task-1', Input: chunk },
        },
      },
      options,
    );
    if (result.decision === 'allow') child.stdin.write(chunk);
    assert.equal(result.decision, 'deny', 'code-source continuity is not a data-input authorization');
  }
  assert.equal(readFileSync(script, 'utf8'), source);
  child.stdin.end();
  assert.equal((await closed)[0], 0);
  assert.equal(output, '', 'denied chunks never reach the live evaluator');
});

test(
  'Native binds the real GENERIC running-task receipt only to its approved effective command',
  {
    skip: !buildAgyDataReceiverCommand(),
  },
  (t) => {
    for (const variant of ['actual', 'user-prose', 'wrong-command']) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-running-task-receipt-')));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const profileHome = join(root, 'profile');
      mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
      const options = { workspaceRoot: root, profileHome };
      const transcriptPath = join(root, 'transcript.jsonl');
      const payload = {
        conversationId: 'receipt-conversation',
        stepIdx: 4,
        transcriptPath,
        workspacePaths: [root],
        toolCall: { id: 'receipt-call', name: 'run_command', args: { CommandLine: buildAgyDataReceiverCommand() } },
      };
      const pre = decideAgyNativeHookPayload(payload, options);
      assert.equal(pre.decision, 'allow');
      const content = `Tool is running as a background task with task id: receipt-conversation/task-4\nTask Description: ${variant === 'wrong-command' ? 'bash' : pre.overwrite.CommandLine}\nTask logs are available at: file:///fixture/task.log\n`;
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          step_index: 4,
          source: variant === 'user-prose' ? 'USER_EXPLICIT' : 'MODEL',
          type: variant === 'user-prose' ? 'USER_INPUT' : 'GENERIC',
          status: 'RUNNING',
          content,
        })}\n`,
      );
      const result = decideAgyNativeHookPayload(
        {
          ...payload,
          stepIdx: 5,
          toolCall: {
            name: 'manage_task',
            args: { Action: 'send_input', TaskId: 'receipt-conversation/task-4', Input: 'continue\n' },
          },
        },
        options,
      );
      assert.equal(result.decision, variant === 'actual' ? 'allow' : 'deny', variant);
    }
  },
);
