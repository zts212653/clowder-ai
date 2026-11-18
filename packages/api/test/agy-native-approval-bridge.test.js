import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { buildAgyDataReceiverCommand } from '../../../scripts/lib/agy-data-input-contract.mjs';

const bridgeUrl = new URL(
  '../dist/domains/cats/services/agents/providers/agy-native/run/agy-native-approval-bridge.js',
  import.meta.url,
).href;
const probe = `
  import assert from 'node:assert/strict';
  const { startAgyNativeApprovalBridge } = await import(process.argv[1]);
  const { mode, ...options } = JSON.parse(process.argv[2]);
  options.runtimeInteractionPort = { request: async () => assert.fail('startup requested an approval') };
  if (mode === 'startup_failure') {
    await assert.rejects(startAgyNativeApprovalBridge(options), { code: 'ENOENT' });
  } else {
    const bridge = await startAgyNativeApprovalBridge(options);
    await bridge.dispose();
    await bridge.dispose();
  }
`;

function runProbe(t, mode) {
  const runHome = mkdtempSync(join(tmpdir(), 'f325-approval-lifetime-'));
  t.after(() => rmSync(runHome, { recursive: true, force: true }));
  if (mode === 'dispose') mkdirSync(join(runHome, '.gemini/config'), { recursive: true });
  const input = {
    mode,
    runHome,
    auditContext: { userId: 'u1', threadId: 't1', catId: 'gemini38', invocationId: 'bridge-lifetime' },
  };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, bridgeUrl, JSON.stringify(input)], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 32 * 1024,
  });
  assert.equal(child.error, undefined, `bridge listener prevented natural exit: ${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr);
}

test('a bridge metadata write failure closes the listener before rejecting startup', (t) => {
  runProbe(t, 'startup_failure');
});

test('a started bridge owns its listener until idempotent disposal completes', (t) => {
  runProbe(t, 'dispose');
});

test(
  'the real guard and approval bridge never authorize content hidden beyond the display limit',
  {
    timeout: 5000,
  },
  async (t) => {
    const { startAgyNativeApprovalBridge } = await import(bridgeUrl);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-approval-visible-action-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.gemini/config'), { recursive: true });
    const requests = [];
    const bridge = await startAgyNativeApprovalBridge({
      runHome: root,
      auditContext: { userId: 'u1', threadId: 't1', catId: 'gemini38', invocationId: 'visible-action' },
      runtimeInteractionPort: {
        request: async (request) => {
          requests.push(request);
          return { kind: 'decision', decisionId: 'allow_once' };
        },
      },
    });
    t.after(() => bridge.dispose());
    const options = {
      workspaceRoot: root,
      profileHome: root,
      requireApproval: true,
      approvalBridgeFile: bridge.bridgeFile,
    };
    const payload = {
      conversationId: 'visible-action',
      stepIdx: 1,
      workspacePaths: [root],
      toolCall: { id: 'data-start', name: 'run_command', args: { CommandLine: buildAgyDataReceiverCommand() } },
    };
    const cases = [
      (content) => ({
        name: 'run_command',
        args: { CommandLine: `printf '%s' '${content}'; echo ACTUAL_TRAILING_ACTION` },
      }),
      (content) => ({ name: 'write_file', args: { Path: join(root, 'note.txt'), Content: content } }),
    ];
    if (buildAgyDataReceiverCommand()) {
      assert.equal((await decideAgyNativeHookPayload(payload, options)).decision, 'allow');
      decideAgyNativeHookPayload(
        { ...payload, hookEventName: 'PostToolUse', output: 'task id: visible-action/task-1' },
        options,
      );
      cases.push((content) => ({
        name: 'manage_task',
        args: { Action: 'send_input', TaskId: 'visible-action/task-1', Input: content },
      }));
    }
    for (const tool of cases) {
      const short = tool('VISIBLE_TRAILING_ACTION');
      assert.equal((await decideAgyNativeHookPayload({ ...payload, toolCall: short }, options)).decision, 'allow');
      assert.deepEqual(
        JSON.parse(requests.at(-1).description).args,
        short.args,
        'approval sees the entire admitted action',
      );
      const before = requests.length;
      const long = tool(`${'x'.repeat(8500)}INVISIBLE_TRAILING_ACTION`);
      const verdict = await decideAgyNativeHookPayload({ ...payload, toolCall: long }, options);
      assert.equal(verdict.decision, 'allow');
      assert.equal(requests.length, before + 1);
      assert.ok(
        requests.at(-1).description.includes('INVISIBLE_TRAILING_ACTION'),
        `${long.name}: approval must include the tail`,
      );
      assert.deepEqual(JSON.parse(requests.at(-1).description).args, long.args);
      const { buildRuntimeInteractionCard } = await import(
        '../dist/domains/runtime-interaction/RuntimeInteractionCardPublisher.js'
      );
      assert.equal(buildRuntimeInteractionCard(requests.at(-1)).bodyMarkdown, requests.at(-1).description);
    }
    const before = requests.length;
    const descriptor = JSON.parse(readFileSync(bridge.bridgeFile, 'utf8'));
    const response = await fetch(descriptor.url, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      body: JSON.stringify({
        token: descriptor.token,
        toolName: 'write_file',
        args: { Content: 'x'.repeat(513 * 1024) },
      }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).approved, false);
    assert.equal(requests.length, before, 'the transport-size bound rejects instead of issuing a partial approval');
  },
);

test(
  'terminal input approval identifies its approved command, task, directory and current bytes',
  {
    skip: !buildAgyDataReceiverCommand(),
    timeout: 4000,
  },
  async (t) => {
    const { startAgyNativeApprovalBridge } = await import(bridgeUrl);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-approval-task-context-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.gemini/config'), { recursive: true });
    const requests = [];
    const bridge = await startAgyNativeApprovalBridge({
      runHome: root,
      auditContext: { userId: 'u1', threadId: 't1', catId: 'gemini38', invocationId: 'task-input-context' },
      runtimeInteractionPort: {
        request: async (request) => {
          requests.push(request);
          return { kind: 'decision', decisionId: 'allow_once' };
        },
      },
    });
    t.after(() => bridge.dispose());
    const command = buildAgyDataReceiverCommand();
    const options = {
      workspaceRoot: root,
      profileHome: root,
      requireApproval: true,
      approvalBridgeFile: bridge.bridgeFile,
    };
    const payload = {
      conversationId: 'approved-data',
      stepIdx: 1,
      workspacePaths: [root],
      toolCall: { id: 'start-data', name: 'run_command', args: { CommandLine: command } },
    };
    assert.equal((await decideAgyNativeHookPayload(payload, options)).decision, 'allow');
    decideAgyNativeHookPayload(
      { ...payload, hookEventName: 'PostToolUse', output: 'task id: approved-data/task-1' },
      options,
    );
    assert.equal(
      (
        await decideAgyNativeHookPayload(
          {
            ...payload,
            stepIdx: 2,
            toolCall: {
              id: 'input-data',
              name: 'manage_task',
              args: { Action: 'send_input', TaskId: 'approved-data/task-1', Input: 'continue\n' },
            },
          },
          options,
        )
      ).decision,
      'allow',
    );
    const context = JSON.parse(requests.at(-1).description);
    assert.deepEqual(context.approvedTask, { taskId: 'approved-data/task-1', command });
    assert.equal(context.cwd, root);
    assert.equal(context.args.Input, 'continue\n');
  },
);

for (const ending of ['dispose', 'disconnect'])
  test(`pending human approval ends with its native request (${ending})`, { timeout: 4000 }, async (t) => {
    const { startAgyNativeApprovalBridge } = await import(bridgeUrl);
    const runHome = mkdtempSync(join(tmpdir(), 'f325-approval-cancel-'));
    t.after(() => rmSync(runHome, { recursive: true, force: true }));
    mkdirSync(join(runHome, '.gemini/config'), { recursive: true });
    let entered;
    const requested = new Promise((resolve) => {
      entered = resolve;
    });
    let approvalSignal;
    let retire;
    const retired = new Promise((resolve) => {
      retire = resolve;
    });
    const bridge = await startAgyNativeApprovalBridge({
      runHome,
      auditContext: { userId: 'u1', threadId: 't1', catId: 'gemini38', invocationId: 'bridge-cancel' },
      runtimeInteractionPort: {
        request: async (_request, control) => {
          approvalSignal = control?.signal;
          entered();
          return new Promise((resolve) =>
            approvalSignal?.addEventListener(
              'abort',
              () => {
                retire();
                resolve({ kind: 'cancelled' });
              },
              { once: true },
            ),
          );
        },
      },
    });
    t.after(() => bridge.dispose());
    const descriptor = JSON.parse(readFileSync(bridge.bridgeFile, 'utf8'));
    const client = new AbortController();
    const transport = fetch(descriptor.url, {
      method: 'POST',
      signal: AbortSignal.any([AbortSignal.timeout(2000), client.signal]),
      body: JSON.stringify({ token: descriptor.token, toolName: 'run_command', args: { CommandLine: 'echo fixture' } }),
    }).catch(() => undefined);
    await requested;
    if (ending === 'dispose') await bridge.dispose();
    else client.abort();
    await transport;
    await retired;
    assert.equal(
      approvalSignal?.aborted,
      true,
      'provider disposal must retire its pending RuntimeInteractionPort request',
    );
  });
