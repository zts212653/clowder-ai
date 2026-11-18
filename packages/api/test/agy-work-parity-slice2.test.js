import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { catRegistry, resolveCliEffortOverride } from '@cat-cafe/shared';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { buildAgyDataReceiverCommand } from '../../../scripts/lib/agy-data-input-contract.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { resolveInvocationCapacitySnapshot } from '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { resolveManagedSessionPolicySnapshot } from '../dist/domains/cats/services/agents/invocation/session-policy-snapshot.js';
import { prepareAgyAcpSession } from '../dist/domains/cats/services/agents/providers/acp/agy/agy-acp-session.js';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { prepareAgyNativeLaunch } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import {
  buildAgyNativePolicy,
  preflightAgyNativeWorkspace,
} from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-policy.js';
import { isolatedOAuthEnv } from '../dist/domains/cats/services/agents/providers/agy-native/launch/agy-native-launch-env.js';
import { AgyNativeRunInput } from '../dist/domains/cats/services/agents/providers/agy-native/run/agy-native-run-input.js';

function withTempRoot(fn) {
  const raw = mkdtempSync(join(tmpdir(), 'f325-parity-s2-'));
  const root = realpathSync(raw);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('F325 AGY Work Parity Slice 2 — Contracts', () => {
  it('Order 3 (Native): autoApprove=false stays fail-closed headless, supports allowWorkspaceWrites, and bridges interactive approval via RuntimeInteractionPort', async () => {
    const raw = mkdtempSync(join(tmpdir(), 'f325-s2-order3-'));
    const root = realpathSync(raw);
    try {
      const workspace = join(root, 'work');
      const homeRoot = join(root, 'profiles');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(homeRoot, { recursive: true });

      // 1) Pure headless autoApprove=false without interaction port or allowWorkspaceWrites stays fail-closed
      const strictPolicy = buildAgyNativePolicy({ workspaceRoot: workspace, autoApprove: false });
      assert.equal(strictPolicy.permissionMode, 'request-review');
      assert.deepEqual(strictPolicy.settings.permissions.allow, ['mcp(*)']);

      // 2) Operator bounded scope: allowWorkspaceWrites=true permits safe in-workspace file writes without enabling commands
      const scopedWritePolicy = buildAgyNativePolicy({
        workspaceRoot: workspace,
        autoApprove: false,
        allowWorkspaceWrites: true,
      });
      assert.equal(scopedWritePolicy.permissionMode, 'request-review');
      assert.deepEqual(scopedWritePolicy.settings.permissions.allow, ['write_file(*)', 'mcp(*)']);

      // 3) Interactive approval bridge routes safe write/command through RuntimeInteractionPort while keeping host guard first
      const interactions = [];
      let nextDecisionId = 'allow_once';
      const runtimeInteractionPort = {
        async request(req) {
          interactions.push(req);
          return { kind: 'decision', decisionId: nextDecisionId };
        },
      };
      const plan = await prepareAgyNativeLaunch({
        catId: 'gemini-carbon',
        model: 'gemini-4-carbon-high',
        workspace,
        profileConfig: {
          enabled: true,
          carrier: 'native',
          autoApprove: false,
          model: 'gemini-4-carbon-high',
          profileId: 'gemini-carbon',
          homeRoot,
          trustedWorkspaces: [workspace],
        },
        prompt: 'edit file',
        body: '# Host L0',
        command: '/usr/bin/true',
        options: {
          invocationId: 'inv-approve-1',
          auditContext: {
            invocationId: 'inv-approve-1',
            threadId: 'thread-1',
            catId: 'gemini-carbon',
            userId: 'user-1',
          },
          runtimeInteractionPort,
          spawnCliOverride: async function* () {},
        },
      });
      try {
        const geminiDirArg = plan.cliOptions.args.find((a) => a.startsWith('--gemini_dir='));
        const runHome = geminiDirArg.slice('--gemini_dir='.length).replace(/\/\.gemini$/, '');
        const bridgeFile = join(runHome, '.gemini/config/.cat-cafe-approval-bridge.json');

        // Safe command -> prompts RuntimeInteractionPort -> allow_once -> allow
        const allowedCmd = await decideAgyNativeHookPayload(
          {
            hookEventName: 'PreToolUse',
            conversationId: 'conv-1',
            stepIdx: 1,
            workspacePaths: [workspace],
            toolCall: { id: 'tc-1', name: 'run_command', args: { CommandLine: 'echo hi' } },
          },
          {
            profileHome: join(homeRoot, 'gemini-carbon'),
            workspaceRoot: workspace,
            requireApproval: true,
            approvalBridgeFile: bridgeFile,
          },
        );
        assert.equal(allowedCmd.decision, 'allow');
        assert.equal(interactions.length, 1);

        // User declines -> deny
        nextDecisionId = 'reject_once';
        const rejectedWrite = await decideAgyNativeHookPayload(
          {
            hookEventName: 'PreToolUse',
            conversationId: 'conv-1',
            stepIdx: 2,
            workspacePaths: [workspace],
            toolCall: { id: 'tc-2', name: 'write_file', args: { Path: join(workspace, 'a.txt'), Content: 'x' } },
          },
          {
            profileHome: join(homeRoot, 'gemini-carbon'),
            workspaceRoot: workspace,
            requireApproval: true,
            approvalBridgeFile: bridgeFile,
          },
        );
        assert.equal(rejectedWrite.decision, 'deny');
        assert.equal(interactions.length, 2);

        // Host control-plane violation fails closed BEFORE calling RuntimeInteractionPort
        nextDecisionId = 'allow_once';
        const controlWrite = await decideAgyNativeHookPayload(
          {
            hookEventName: 'PreToolUse',
            conversationId: 'conv-1',
            stepIdx: 3,
            workspacePaths: [workspace],
            toolCall: {
              id: 'tc-3',
              name: 'write_file',
              args: { Path: join(workspace, '.agents/hooks.json'), Content: '{}' },
            },
          },
          {
            profileHome: join(homeRoot, 'gemini-carbon'),
            workspaceRoot: workspace,
            requireApproval: true,
            approvalBridgeFile: bridgeFile,
          },
        );
        assert.equal(controlWrite.decision, 'deny');
        assert.equal(interactions.length, 2, 'host guard denial must never prompt human');
      } finally {
        await plan.disposeCredentials?.();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Order 5: .agents preflight allows empty dirs, non-shadowing subagents & in-repo skills.json while blocking host shadowing and unauthorized hooks/MCP', () => {
    withTempRoot((root) => {
      const work = join(root, 'repo');
      mkdirSync(join(work, '.agents/agents/reviewer'), { recursive: true });
      mkdirSync(join(work, '.agents/plugins/team-rules/skills/style'), { recursive: true });
      mkdirSync(join(work, 'tools/skills'), { recursive: true });
      writeFileSync(join(work, '.agents/agents/reviewer/agent.md'), '---\nname: reviewer\n---\nReview helper.\n');
      writeFileSync(join(work, '.agents/plugins/team-rules/plugin.json'), JSON.stringify({ name: 'team-rules' }));
      writeFileSync(join(work, '.agents/skills.json'), JSON.stringify({ entries: [{ path: 'tools/skills' }] }));

      assert.deepEqual(preflightAgyNativeWorkspace(work, { hostAgentName: 'cat-cafe-host-gemini-carbon' }), {
        ok: true,
      });

      // Shadowing host agent (case-insensitive) is ALWAYS blocked even when allowWorkspaceExecutableConfig=true
      mkdirSync(join(work, '.agents/agents/CAT-CAFE-HOST-GEMINI-CARBON'), { recursive: true });
      writeFileSync(join(work, '.agents/agents/CAT-CAFE-HOST-GEMINI-CARBON/agent.md'), 'SHADOW');
      assert.equal(
        preflightAgyNativeWorkspace(work, {
          hostAgentName: 'cat-cafe-host-gemini-carbon',
          allowWorkspaceExecutableConfig: true,
        }).ok,
        false,
      );
      rmSync(join(work, '.agents/agents/CAT-CAFE-HOST-GEMINI-CARBON'), { recursive: true, force: true });

      // Active hooks.json / mcp_config.json blocked by default, allowed only when operator sets allowWorkspaceExecutableConfig=true
      writeFileSync(
        join(work, '.agents/hooks.json'),
        JSON.stringify({ evil: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'touch /tmp/pwn' }] }] } }),
      );
      assert.equal(preflightAgyNativeWorkspace(work, { hostAgentName: 'cat-cafe-host-gemini-carbon' }).ok, false);
      assert.equal(
        preflightAgyNativeWorkspace(work, {
          hostAgentName: 'cat-cafe-host-gemini-carbon',
          allowWorkspaceExecutableConfig: true,
        }).ok,
        true,
      );
      rmSync(join(work, '.agents/hooks.json'));

      // skills.json escaping workspace is refused
      writeFileSync(join(work, '.agents/skills.json'), JSON.stringify({ entries: [{ path: '../outside' }] }));
      assert.equal(preflightAgyNativeWorkspace(work, { hostAgentName: 'cat-cafe-host-gemini-carbon' }).ok, false);
    });
  });

  it('Order 6a: F306 main-checkout read-only shell for-loops pass while dynamic git/eval/exec loops stay denied', () => {
    withTempRoot((root) => {
      const mainRepo = join(root, 'projects/relay-station/cat-cafe');
      mkdirSync(mainRepo, { recursive: true });
      execFileSync('git', ['init', '-b', 'main', mainRepo], { stdio: 'ignore' });

      const probeCmd =
        'for bin in rg git gh node pnpm python3 agy; do echo "$bin -> $(command -v $bin || echo MISSING)"; done';
      const probeVerdict = decideNativeHookPayload(
        { tool_name: 'Bash', tool_input: { command: probeCmd }, cwd: mainRepo },
        {},
      );
      assert.equal(probeVerdict.decision, 'allow', JSON.stringify(probeVerdict));

      const wideItems = Array.from({ length: 24 }, (_, i) => `tool_${i}`).join(' ');
      const wideProbe = `for bin in ${wideItems}; do printf "%s\\n" "$(which "$bin" || type "$bin" || true)"; done`;
      const wideVerdict = decideNativeHookPayload(
        { tool_name: 'Bash', tool_input: { command: wideProbe }, cwd: mainRepo },
        {},
      );
      assert.equal(wideVerdict.decision, 'allow', JSON.stringify(wideVerdict));

      for (const bad of [
        'for sub in reset status; do git $sub --hard; done',
        'for sub in $UNKNOWN_GIT_OPS; do git $sub; done',
        'for c in ls pwd; do eval "$c"; done',
        'for bin in $UNKNOWN_BINS; do command $bin --version; done',
      ]) {
        const v = decideNativeHookPayload({ tool_name: 'Bash', tool_input: { command: bad }, cwd: mainRepo }, {});
        assert.equal(v.decision, 'deny', `expected deny for: ${bad}`);
      }
    });
  });

  it(
    'Order 6b: send_command_input and manage_task(send_input) enforce conversation/task ledger binding',
    { skip: !buildAgyDataReceiverCommand() },
    async () => {
      withTempRoot((root) => {
        const profileHome = join(root, 'profile');
        const workspace = join(root, 'work');
        const transcriptDir = join(root, 'brain/conv-ledger/.system_generated/logs');
        mkdirSync(join(profileHome, '.gemini/config'), { recursive: true });
        mkdirSync(workspace, { recursive: true });
        mkdirSync(transcriptDir, { recursive: true });
        const transcriptPath = join(transcriptDir, 'transcript_full.jsonl');

        // 1) Approve run_command at stepIdx 4 in conv-ledger
        const preRun = decideAgyNativeHookPayload(
          {
            hookEventName: 'PreToolUse',
            conversationId: 'conv-ledger',
            stepIdx: 4,
            transcriptPath,
            workspacePaths: [workspace],
            toolCall: {
              id: 'call-4',
              name: 'run_command',
              args: {
                CommandLine: buildAgyDataReceiverCommand(),
                WaitMsBeforeAsync: 500,
              },
            },
          },
          { profileHome, workspaceRoot: workspace },
        );
        assert.equal(preRun.decision, 'allow');

        // Transcript records background task id conv-ledger/task-4 for step_index 4
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({
            step_index: 4,
            type: 'TOOL_CALL',
            status: 'DONE',
            output: 'Tool is running as a background task with task id: conv-ledger/task-4\n',
          })}\n`,
        );

        // 2) Authorized send_command_input and manage_task(send_input) for conv-ledger/task-4 succeed
        for (const toolCall of [
          { id: 'c5', name: 'send_command_input', args: { CommandId: 'conv-ledger/task-4', Input: 'continue\n' } },
          {
            id: 'c6',
            name: 'manage_task',
            args: { Action: 'send_input', TaskId: 'conv-ledger/task-4', Input: 'continue\n' },
          },
        ]) {
          const res = decideAgyNativeHookPayload(
            {
              hookEventName: 'PreToolUse',
              conversationId: 'conv-ledger',
              stepIdx: 5,
              transcriptPath,
              workspacePaths: [workspace],
              toolCall,
            },
            { profileHome, workspaceRoot: workspace },
          );
          assert.equal(res.decision, 'allow', JSON.stringify(res));
        }

        // 3) Forged task id or different conversationId is denied
        const forged = decideAgyNativeHookPayload(
          {
            hookEventName: 'PreToolUse',
            conversationId: 'conv-ledger',
            stepIdx: 6,
            transcriptPath,
            workspacePaths: [workspace],
            toolCall: {
              id: 'c7',
              name: 'send_command_input',
              args: { CommandId: 'conv-ledger/task-999', Input: 'y\n' },
            },
          },
          { profileHome, workspaceRoot: workspace },
        );
        assert.equal(forged.decision, 'deny');

        const wrongConv = decideAgyNativeHookPayload(
          {
            hookEventName: 'PreToolUse',
            conversationId: 'other-conv',
            stepIdx: 6,
            transcriptPath,
            workspacePaths: [workspace],
            toolCall: {
              id: 'c8',
              name: 'manage_task',
              args: { Action: 'send_input', TaskId: 'conv-ledger/task-4', Input: 'y\n' },
            },
          },
          { profileHome, workspaceRoot: workspace },
        );
        assert.equal(wrongConv.decision, 'deny');
      });
    },
  );

  it('Order 7a: mid-run image supplement adds uploadDir --add-dir, validates scope, deduplicates with images, and emits receipts', async () => {
    const raw = mkdtempSync(join(tmpdir(), 'f325-s2-img-'));
    const root = realpathSync(raw);
    try {
      const workspace = join(root, 'work');
      const uploadDir = join(root, 'uploads');
      const outsideDir = join(root, 'outside');
      const homeRoot = join(root, 'profiles');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(uploadDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(homeRoot, { recursive: true });
      const img1 = join(uploadDir, 'shot1.png');
      const img2 = join(uploadDir, 'shot2.png');
      const outsideImg = join(outsideDir, 'secret.png');
      writeFileSync(img1, 'png1');
      writeFileSync(img2, 'png2');
      writeFileSync(outsideImg, 'png3');
      symlinkSync(outsideImg, join(uploadDir, 'escape-link.png'));

      const plan = await prepareAgyNativeLaunch({
        catId: 'gemini-carbon',
        model: 'gemini-4-carbon-high',
        workspace,
        profileConfig: {
          enabled: true,
          carrier: 'native',
          autoApprove: true,
          model: 'gemini-4-carbon-high',
          profileId: 'gemini-carbon',
          homeRoot,
          trustedWorkspaces: [workspace],
        },
        prompt: 'initial',
        body: '# L0',
        command: '/usr/bin/true',
        options: { invocationId: 'inv-img', uploadDir, spawnCliOverride: async function* () {} },
      });
      try {
        assert.ok(plan.cliOptions.args.includes(uploadDir), 'prepareAgyNativeLaunch must include canonical uploadDir');
      } finally {
        await plan.disposeCredentials?.();
      }

      let registeredDispatch;
      const writtenLines = [];
      let readCount = 0;
      const completed = [];
      const runInput = new AgyNativeRunInput(
        {
          workingDirectory: workspace,
          uploadDir,
          activeRunDispatch: {
            invocationId: 'inv-img',
            register(reg) {
              registeredDispatch = reg.dispatch;
              return () => {};
            },
          },
        },
        () => {},
        workspace,
        undefined,
        plan.supplementalUploadDir,
      );
      runInput.onStdinReady((line) => writtenLines.push(line));
      runInput.register('conv-img');
      await runInput.step({ kind: 'step', stepType: 'user_input', stepIndex: 0, state: 'DONE' });

      // Escape symlink rejected
      const escaped = await registeredDispatch(
        {
          deliveryId: 'd-escape',
          text: 'look',
          messageIds: ['m0'],
          imagePaths: [join(uploadDir, 'escape-link.png')],
        },
        { expectedInvocationId: 'inv-img' },
      );
      assert.equal(escaped.accepted, false);

      // Valid mid-run screenshot accepted + idempotent on identical retry + rejected if imagePaths mutated
      const ok = await registeredDispatch(
        {
          deliveryId: 'd-1',
          text: 'check screenshot',
          messageIds: ['m1'],
          imagePaths: [img1],
          onInputRead: async () => {
            readCount++;
          },
          onInputCompleted: async (s) => {
            completed.push(s);
          },
        },
        { expectedInvocationId: 'inv-img' },
      );
      assert.equal(ok.accepted, true);
      assert.equal(writtenLines.length, 1);
      assert.match(writtenLines[0], /\[User attachments — read their contents before answering\]/);
      assert.ok(writtenLines[0].includes(img1));

      const retrySame = await registeredDispatch(
        { deliveryId: 'd-1', text: 'check screenshot', messageIds: ['m1'], imagePaths: [img1] },
        { expectedInvocationId: 'inv-img' },
      );
      assert.equal(retrySame.accepted, true);
      assert.equal(writtenLines.length, 1);

      const retryMutated = await registeredDispatch(
        { deliveryId: 'd-1', text: 'check screenshot', messageIds: ['m1'], imagePaths: [img2] },
        { expectedInvocationId: 'inv-img' },
      );
      assert.equal(retryMutated.accepted, false);
      assert.equal(retryMutated.reason, 'invalid_input');

      runInput.observeResult(true);
      await runInput.completeTurn(true);
      await runInput.step({ kind: 'step', stepType: 'user_input', stepIndex: 5, state: 'DONE' });
      assert.equal(readCount, 1);
      runInput.observeResult(true);
      assert.deepEqual(completed, []);
      await runInput.completeTurn(true);
      assert.deepEqual(completed, [true]);
      await runInput.dispose();
      assert.deepEqual(completed, [true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Order 7b: maps reasoningEffortOverride safely, filters dangerous accountEnv keys, and cleans PATH + exposes rg', async () => {
    const raw = mkdtempSync(join(tmpdir(), 'f325-s2-env-'));
    const root = realpathSync(raw);
    try {
      const workspace = join(root, 'work');
      const homeRoot = join(root, 'profiles');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(homeRoot, { recursive: true });

      assert.deepEqual(resolveCliEffortOverride('google', 'gemini-4-carbon-high', 'high', 'low'), {
        effective: 'low',
        source: 'thread_override',
        compatibility: 'compatible',
      });
      assert.deepEqual(resolveCliEffortOverride('google', 'gemini-4-carbon-high', 'high', 'ultra'), {
        effective: 'high',
        source: 'inherited',
        compatibility: 'incompatible',
      });

      const plan = await prepareAgyNativeLaunch({
        catId: 'gemini-carbon',
        model: 'gemini-4-carbon-high',
        workspace,
        profileConfig: {
          enabled: true,
          carrier: 'native',
          autoApprove: true,
          model: 'gemini-4-carbon-high',
          profileId: 'gemini-carbon',
          homeRoot,
          trustedWorkspaces: [workspace],
        },
        prompt: 'hi',
        body: '# L0',
        command: '/usr/bin/true',
        options: {
          invocationId: 'inv-effort',
          reasoningEffortOverride: 'low',
          accountEnv: { TZ: 'UTC', CUSTOM_DEV_FLAG: 'enabled' },
          spawnCliOverride: async function* () {},
        },
      });
      try {
        const modelIdx = plan.cliOptions.args.indexOf('--model');
        const effortIdx = plan.cliOptions.args.indexOf('--effort');
        assert.equal(plan.cliOptions.args[modelIdx + 1], 'gemini-4-carbon-low');
        assert.equal(plan.cliOptions.args[effortIdx + 1], 'low');
        assert.equal(plan.cliOptions.env.TZ, 'UTC');
        assert.equal(plan.cliOptions.env.CUSTOM_DEV_FLAG, 'enabled');
      } finally {
        await plan.disposeCredentials?.();
      }

      // Dangerous accountEnv keys rejected on both Native and ACP
      for (const badKey of [
        'GEMINI_API_KEY',
        'GOOGLE_GEMINI_BASE_URL',
        'HOME',
        'HTTPS_PROXY',
        'NODE_OPTIONS',
        'PATH',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_PARAMETERS',
        'git_exec_path',
      ]) {
        const svc = new AgyNativeAgentService({
          catId: 'gemini-carbon',
          profile: {
            enabled: true,
            carrier: 'native',
            autoApprove: true,
            model: 'gemini-4-carbon-high',
            profileId: 'gemini-carbon',
            homeRoot,
            trustedWorkspaces: [workspace],
          },
          command: '/usr/bin/true',
          l0CompilerFn: async () => '# L0',
        });
        const msgs = [];
        for await (const m of svc.invoke('hi', {
          workingDirectory: workspace,
          accountEnv: { [badKey]: 'override' },
        })) {
          msgs.push(m);
        }
        assert.ok(
          msgs.some((m) => m.type === 'error'),
          `Native must reject dangerous accountEnv key ${badKey}`,
        );

        await assert.rejects(
          () =>
            prepareAgyAcpSession({
              config: {
                profile: {
                  enabled: true,
                  carrier: 'acp',
                  autoApprove: true,
                  model: 'gemini-4-carbon-high',
                  trustedWorkspaces: [workspace],
                },
                profileHome: homeRoot,
                l0CompilerFn: async () => '# L0',
              },
              catId: 'gemini-carbon',
              model: 'gemini-4-carbon-high',
              cwd: workspace,
              capabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
              options: { accountEnv: { [badKey]: 'override' } },
            }),
          /account/i,
        );
      }

      // ACP's process is profile-scoped: it cannot silently accept a per-turn environment.
      await assert.rejects(
        () =>
          prepareAgyAcpSession({
            config: {
              profile: {
                enabled: true,
                carrier: 'acp',
                autoApprove: true,
                model: 'gemini-4-carbon-high',
                trustedWorkspaces: [workspace],
              },
              profileHome: homeRoot,
              l0CompilerFn: async () => '# L0',
            },
            catId: 'gemini-carbon',
            model: 'gemini-4-carbon-high',
            cwd: workspace,
            capabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
            options: { accountEnv: { TZ: 'UTC' } },
          }),
        /account.*environment.*overrid/i,
      );

      // PATH strips multiline npm bin error text and exposes rg
      const prevPath = process.env.PATH;
      try {
        process.env.PATH =
          '/usr/bin:/bin:Unknown command: "bin"\n\nTo see a list of supported npm commands, run:\n  npm help';
        const env = isolatedOAuthEnv(homeRoot);
        assert.ok(!env.PATH.includes('Unknown command'), `corrupted segment remained in PATH: ${env.PATH}`);
        assert.ok(!env.PATH.includes('\n'), 'PATH must not contain newlines');
        const rgCheck = execFileSync('/bin/sh', ['-c', 'command -v rg'], {
          env: { PATH: env.PATH },
          encoding: 'utf8',
        }).trim();
        assert.ok(rgCheck.endsWith('/rg'), `expected rg on sanitized PATH, got: ${rgCheck}`);
      } finally {
        process.env.PATH = prevPath;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Order 7c: unknown AGY carrier windows cannot acquire actionable capacity from a model label', () => {
    const testCatId = 'test-f325-parity-capacity-cat';
    const savedConfigs = catRegistry.getAllConfigs();
    try {
      for (const model of ['gemini-4-carbon-high', 'gemini-4-argon-high', 'gemini-3.8-flash-high']) {
        catRegistry.reset();
        catRegistry.register(testCatId, {
          id: testCatId,
          name: 'Test Cat',
          displayName: 'Test Cat',
          avatar: '',
          color: { primary: '#000', secondary: '#fff' },
          mentionPatterns: ['@test-f325-cap'],
          clientId: 'google',
          carrier: 'cli',
          defaultModel: model,
          mcpSupport: true,
          roleDescription: 'test',
          personality: 'test',
          agyProfile: { enabled: true, carrier: 'native', model },
        });
        const service = new AgyNativeAgentService({
          catId: testCatId,
          profile: { enabled: true, carrier: 'native', model },
          command: '/usr/bin/true',
        });
        assert.equal(service.contextCapability().nativeWindowControl, false);
        const snapshot = resolveInvocationCapacitySnapshot({ catId: testCatId, service });
        assert.equal(snapshot.capacity.source, 'unresolved');
        assert.equal(snapshot.capacity.windowTokens, 0);
        assert.equal(snapshot.capacity.actionable, false);
        assert.equal(snapshot.binding, undefined);

        const policy = resolveManagedSessionPolicySnapshot({
          catId: testCatId,
          evidence: {
            capacitySnapshot: snapshot,
            authoritativeUsage: true,
            sessionRotation: true,
            continuityBootstrap: true,
          },
        });
        assert.equal(policy.execution.status, 'unavailable');
        assert.ok(policy.execution.missingCapabilities.includes('effective_input_ceiling'));
      }

      // Unknown custom model remains unresolved (no provider-wide guessing)
      catRegistry.reset();
      catRegistry.register(testCatId, {
        id: testCatId,
        name: 'Test Cat',
        displayName: 'Test Cat',
        avatar: '',
        color: { primary: '#000', secondary: '#fff' },
        mentionPatterns: ['@test-f325-cap'],
        clientId: 'google',
        carrier: 'cli',
        defaultModel: 'custom-unverified-model',
        mcpSupport: true,
        roleDescription: 'test',
        personality: 'test',
        agyProfile: { enabled: true, carrier: 'native', model: 'custom-unverified-model' },
      });
      const unknownService = new AgyNativeAgentService({
        catId: testCatId,
        profile: { enabled: true, carrier: 'native', model: 'custom-unverified-model' },
        command: '/usr/bin/true',
      });
      const unknownSnap = resolveInvocationCapacitySnapshot({ catId: testCatId, service: unknownService });
      assert.equal(unknownSnap.capacity.source, 'unresolved');
      assert.equal(unknownSnap.capacity.actionable, false);
      assert.equal(unknownSnap.binding, undefined);
    } finally {
      catRegistry.reset();
      for (const [id, cfg] of Object.entries(savedConfigs)) {
        catRegistry.register(id, cfg);
      }
    }
  });
});
