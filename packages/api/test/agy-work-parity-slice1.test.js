import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { captureFrozenL0Input } from '@cat-cafe/shared/l0-input-capture';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { prepareAgyNativeLaunch } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch.js'
);
const { materializeAgyNativeSettings } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-settings.js'
);
const { buildAgyNativePolicy } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-policy.js'
);
const { AGY_NATIVE_TOOLS, deduplicateAgyNativeFileTools } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-tools.js'
);
const { verifiedInitSessionId } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-stream-validation.js'
);
const { projectAgyNativeTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js'
);
const { summarizeAgyStreamJsonTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'
);
const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { resolveCliCommand } = await import('../dist/utils/cli-resolve.js');
const { spawnCli } = await import('../dist/utils/cli-spawn.js');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function fakeNativeSpawn(launches, conversationId = 'conv-parity-1') {
  return async function* (launch) {
    launches.push(launch);
    const agent = launch.args[launch.args.indexOf('--agent') + 1];
    const model = launch.args[launch.args.indexOf('--model') + 1];
    const permissionMode = launch.args.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review';
    yield {
      event: 'init',
      conversation_id: conversationId,
      init: {
        agent,
        cwd: launch.cwd,
        model,
        permission_mode: permissionMode,
        tools: ['read_file', 'write_file', 'run_command'],
      },
    };
    yield {
      event: 'result',
      result: { conversation_id: conversationId, status: 'SUCCESS', response: 'PARITY-OK', num_turns: launches.length },
    };
  };
}

describe('F325 AGY Work Parity Slice 1', () => {
  test('Native session resumes across nickname, restriction, governance, model, permission, OAuth account and related worktree changes while rejecting unrelated repos or foreign cats', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-parity-s1-native-')));
    try {
      const mainRepo = join(root, 'repo-main');
      const siblingWorktree = join(root, 'repo-wt');
      const unrelatedRepo = join(root, 'unrelated-repo');
      mkdirSync(mainRepo);
      mkdirSync(unrelatedRepo);
      execFileSync('git', ['init', '-q'], { cwd: mainRepo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
      writeFileSync(join(mainRepo, 'README.md'), '# fixture\n');
      execFileSync('git', ['add', 'README.md'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: mainRepo });
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-branch', siblingWorktree], { cwd: mainRepo });

      const homeRoot = join(root, 'profiles');
      let currentL0 = '## 1. 身份\n你是 暹罗猫/烁烁。\n**硬限制**：禁止写代码。\n## 3. 家规\nRule v1.\n';
      const makeService = (model = 'gemini-4-argon-high', autoApprove = true) =>
        new AgyNativeAgentService({
          catId: 'gemini-carbon',
          command: '/usr/bin/true',
          profile: {
            enabled: true,
            carrier: 'native',
            profileId: 'gemini-argon',
            homeRoot,
            model,
            autoApprove,
            trustedWorkspaces: [mainRepo, siblingWorktree, unrelatedRepo],
          },
          l0CompilerFn: async () => currentL0,
        });

      const launches = [];
      const serviceV1 = makeService('gemini-4-argon-high', true);
      const t1 = await collect(
        serviceV1.invoke('Turn 1', {
          workingDirectory: mainRepo,
          spawnCliOverride: fakeNativeSpawn(launches, 'conv-live-1'),
        }),
      );
      assert.equal(t1.at(-1)?.errorCode, undefined, JSON.stringify(t1));
      let binding = t1.find((e) => e.type === 'session_init').nativeSessionBinding;

      // Simulate legacy pre-upgrade hashed binding (e.g. Argon/Carbon active session before Slice 1)
      const legacyHash = createHash('sha256').update(currentL0).digest('hex');
      const legacyBinding = {
        ...binding,
        l0Hash: legacyHash,
        agentName: `cat-cafe-gemini-carbon-${legacyHash.slice(0, 16)}-auto`,
      };

      // 1) Nickname + restriction unlocked + governance updated on legacy binding -> MUST resume without sealing!
      currentL0 = '## 1. 身份\n你是 暹罗猫/碳碳·烁烁。\n## 3. 家规\nRule v2 (updated).\n';
      const t2 = await collect(
        serviceV1.invoke('Turn 2 after nickname and restriction edit', {
          workingDirectory: mainRepo,
          sessionId: 'conv-live-1',
          nativeSessionBinding: legacyBinding,
          spawnCliOverride: fakeNativeSpawn(launches, 'conv-live-1'),
        }),
      );
      assert.equal(t2.at(-1)?.errorCode, undefined, JSON.stringify(t2));
      assert.deepEqual(launches.at(-1).args.slice(-2), ['--conversation', 'conv-live-1']);
      binding = t2.find((e) => e.type === 'session_init').nativeSessionBinding;

      // 2) Model switch + autoApprove false switch + related git worktree switch -> MUST resume without sealing!
      const serviceV2 = makeService('gemini-4-carbon-high', false);
      const t3 = await collect(
        serviceV2.invoke('Turn 3 in worktree with new model and request-review', {
          workingDirectory: siblingWorktree,
          sessionId: 'conv-live-1',
          nativeSessionBinding: binding,
          spawnCliOverride: fakeNativeSpawn(launches, 'conv-live-1'),
        }),
      );
      assert.equal(t3.at(-1)?.errorCode, undefined, JSON.stringify(t3));
      assert.deepEqual(launches.at(-1).args.slice(-2), ['--conversation', 'conv-live-1']);
      binding = t3.find((e) => e.type === 'session_init').nativeSessionBinding;

      // 3) Per-turn read_only restriction followed by normal read-write -> MUST resume both turns!
      const serviceV3 = makeService('gemini-4-carbon-high', true);
      const t4ReadOnly = await collect(
        serviceV3.invoke('Turn 4 read-only', {
          workingDirectory: siblingWorktree,
          sessionId: 'conv-live-1',
          nativeSessionBinding: binding,
          toolExecutionPolicy: { mode: 'read_only' },
          spawnCliOverride: fakeNativeSpawn(launches, 'conv-live-1'),
        }),
      );
      assert.equal(t4ReadOnly.at(-1)?.errorCode, undefined);
      binding = t4ReadOnly.find((e) => e.type === 'session_init').nativeSessionBinding;

      const t5BackToNormal = await collect(
        serviceV3.invoke('Turn 5 normal again', {
          workingDirectory: mainRepo,
          sessionId: 'conv-live-1',
          nativeSessionBinding: binding,
          spawnCliOverride: fakeNativeSpawn(launches, 'conv-live-1'),
        }),
      );
      assert.equal(t5BackToNormal.at(-1)?.errorCode, undefined);
      binding = t5BackToNormal.find((e) => e.type === 'session_init').nativeSessionBinding;

      // 4) Unrelated repository switch MUST rotate session (AGY retains prior workspace in conversation)
      const countBeforeRejects = launches.length;
      const unrelated = await collect(
        serviceV3.invoke('Unrelated repo', {
          workingDirectory: unrelatedRepo,
          sessionId: 'conv-live-1',
          nativeSessionBinding: binding,
          spawnCliOverride: fakeNativeSpawn(launches, 'must-not-run'),
        }),
      );
      assert.equal(unrelated.at(-1)?.errorCode, 'AGY_NATIVE_RESUME_MISMATCH');

      // 5) Foreign cat binding MUST be rejected
      const foreignCat = await collect(
        serviceV3.invoke('Foreign cat binding', {
          workingDirectory: mainRepo,
          sessionId: 'conv-live-1',
          nativeSessionBinding: { ...binding, agentName: 'cat-cafe-host-other-cat' },
          spawnCliOverride: fakeNativeSpawn(launches, 'must-not-run'),
        }),
      );
      assert.equal(foreignCat.at(-1)?.errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, countBeforeRejects);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('autoApprove=true OAuth account launch passes per-run --settings with enableTerminalSandbox=false and tolerates benign CLI settings keys', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-parity-s1-settings-')));
    try {
      const workspace = join(root, 'workspace');
      const homeRoot = join(root, 'profiles');
      const profileHome = join(homeRoot, 'gemini-argon');
      const credentialHome = join(root, 'account-cred');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(profileHome, '.gemini/antigravity-cli'), { recursive: true, mode: 0o700 });
      mkdirSync(join(credentialHome, '.gemini/antigravity-cli'), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(credentialHome, '.gemini/antigravity-cli/antigravity-oauth-token'),
        JSON.stringify({
          auth_method: 'consumer',
          token: { access_token: 'tok', refresh_token: 'ref', expiry: '2099-01-01T00:00:00Z' },
        }),
        { mode: 0o600 },
      );
      // Simulate benign future CLI UI setting written into shared profile settings.json
      const sharedSettingsPath = join(profileHome, '.gemini/antigravity-cli/settings.json');
      writeFileSync(
        sharedSettingsPath,
        JSON.stringify({
          model: 'gemini-4-carbon-high',
          trustedWorkspaces: [workspace],
          colorScheme: 'dark',
          uiThemeVariant: 'nebula-1.6',
        }),
      );

      const plan = await prepareAgyNativeLaunch({
        catId: 'gemini-carbon',
        model: 'gemini-4-carbon-high',
        workspace,
        profileConfig: {
          enabled: true,
          carrier: 'native',
          profileId: 'gemini-argon',
          homeRoot,
          model: 'gemini-4-carbon-high',
          autoApprove: true,
          trustedWorkspaces: [workspace],
        },
        prompt: 'Run tests.',
        body: '# Identity\nCarbon.\n',
        command: process.execPath,
        options: {
          invocationId: 'inv-settings-1',
          agyAccount: { storage: 'cli_file', credentialHome },
        },
      });
      try {
        const settingsIdx = plan.cliOptions.args.indexOf('--settings');
        assert.ok(settingsIdx >= 0, 'launch must pass explicit --settings');
        const passedSettingsPath = plan.cliOptions.args[settingsIdx + 1];
        assert.notEqual(
          realpathSync(passedSettingsPath),
          realpathSync(sharedSettingsPath),
          '--settings must point to isolated per-run settings, not restricted shared baseline',
        );
        const passedSettings = JSON.parse(readFileSync(passedSettingsPath, 'utf8'));
        assert.equal(passedSettings.enableTerminalSandbox, false);
        assert.equal(passedSettings.toolPermission, 'always-proceed');
        assert.equal(passedSettings.allowNonWorkspaceAccess, true);

        // Dangerous auth/execution keys in settings.json MUST still be rejected
        for (const dangerous of [
          { modelProvider: 'gemini' },
          { auth: { type: 'api_key' } },
          { statusLine: { command: 'x' } },
        ]) {
          const badHome = mkdtempSync(join(root, 'bad-home-'));
          mkdirSync(join(badHome, '.gemini/antigravity-cli'), { recursive: true });
          writeFileSync(join(badHome, '.gemini/antigravity-cli/settings.json'), JSON.stringify(dangerous));
          assert.throws(() =>
            materializeAgyNativeSettings({
              profileHome: badHome,
              model: 'gemini-4-carbon-high',
              policy: buildAgyNativePolicy({ workspaceRoot: workspace }),
            }),
          );
        }
      } finally {
        await plan.disposeCredentials?.();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ACP resumes across L0/model/permission edits and routes autoApprove=false safe edits through ask_user instead of rejecting or auto-running', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-parity-s1-acp-')));
    try {
      const workspace = join(root, 'work');
      const home = join(root, 'profile');
      mkdirSync(workspace);
      mkdirSync(home);
      let l0Body = '## 1. 身份\n你是 烁烁（v1）。';
      let capturedPermissionHandler;
      const calls = [];
      const makeAcpService = ({ model = 'gemini-4-argon-high', autoApprove = false, executionApproval } = {}) => {
        const configOptions = [{ id: 'model', currentValue: model, options: [{ value: model }] }];
        const client = {
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
            _meta: { antigravity: { systemPrompt: { append: true } } },
          },
          promptCapabilities: {},
          newSession: async (...args) => {
            calls.push(['new', ...args]);
            return { sessionId: 'acp-conv-1', configOptions };
          },
          resumeSession: async (...args) => {
            calls.push(['resume', ...args]);
            return { sessionId: args[0], configOptions };
          },
          loadSession: async (...args) => ({ sessionId: args[0], configOptions }),
          setSessionConfigOption: async (...args) => calls.push(['setModel', ...args]),
          setSessionPermissionHandler: (_sid, handler) => {
            capturedPermissionHandler = handler;
          },
          cancelSession() {},
          onCapacity() {},
          offCapacity() {},
          clearRecentCapacitySignal() {},
          recentCapacitySignal: null,
          async *promptStream(sid) {
            // Trigger permission check during active prompt phase!
            if (capturedPermissionHandler) {
              const safeEditReq = {
                id: 'req-edit-1',
                params: {
                  sessionId: sid,
                  options: [
                    { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject-1', name: 'Reject once', kind: 'reject_once' },
                  ],
                  toolCall: {
                    title: 'write_file',
                    kind: 'edit',
                    rawInput: { Path: join(workspace, 'hello.txt'), Content: 'hi' },
                  },
                },
              };
              await new Promise((done) =>
                capturedPermissionHandler(safeEditReq, (decision) => {
                  calls.push(['perm-safe-edit', decision]);
                  done();
                }),
              );
              const tokenLeakReq = {
                id: 'req-leak-1',
                params: {
                  sessionId: sid,
                  options: [
                    { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
                    { optionId: 'reject-1', name: 'Reject once', kind: 'reject_once' },
                  ],
                  toolCall: {
                    title: 'write_file',
                    kind: 'edit',
                    rawInput: { Path: join(home, '.gemini/antigravity-acp/acp_token.json'), Content: 'x' },
                  },
                },
              };
              await new Promise((done) =>
                capturedPermissionHandler(tokenLeakReq, (decision) => {
                  calls.push(['perm-protected-target', decision]);
                  done();
                }),
              );
            }
            yield {
              sessionId: sid,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
            };
            return 'end_turn';
          },
        };
        const pool = {
          acquire: async () => ({ client, release() {}, canResumeRequestedSession: true }),
          rememberSession() {},
          release() {},
        };
        return new AcpAgentService({
          catId: 'gemini-argon',
          pool,
          poolKey: { projectPath: workspace, providerProfile: 'argon' },
          projectRoot: workspace,
          providerName: 'google',
          modelName: model,
          sessionModel: model,
          ...(executionApproval ? { executionApproval } : {}),
          mcpServers: [],
          antigravity: {
            profile: {
              carrier: 'acp',
              enabled: true,
              profileId: 'argon',
              model,
              autoApprove,
              trustedWorkspaces: [workspace],
            },
            profileHome: home,
            l0CompilerFn: async () => l0Body,
          },
        });
      };

      const approvalRequests = [];
      const port = {
        request: async (req) => {
          approvalRequests.push(req);
          const accept = req.decisions.find((d) => d.outcome === 'accept');
          return { kind: 'decision', decisionId: accept.id };
        },
      };

      // Even when executionApproval is omitted (defaults to 'auto' in factory), autoApprove=false MUST route to ask_user!
      const s1 = makeAcpService({ model: 'gemini-4-argon-high', autoApprove: false });
      const r1 = await collect(
        s1.invoke('Turn 1', {
          workingDirectory: workspace,
          runtimeInteractionPort: port,
          auditContext: { userId: 'owner', threadId: 't1', invocationId: 'inv1', catId: 'gemini-argon' },
        }),
      );
      assert.equal(
        r1.some((e) => e.type === 'error'),
        false,
        JSON.stringify(r1),
      );
      assert.equal(
        approvalRequests.length,
        1,
        'safe edit must ask human via RuntimeInteractionPort, not pre-reject or auto-run',
      );
      assert.deepEqual(calls.find(([k]) => k === 'perm-safe-edit')[1], { optionId: 'allow-1' });
      assert.deepEqual(
        calls.find(([k]) => k === 'perm-protected-target')[1],
        { optionId: 'reject-1' },
        'protected token target must still be denied by guard without asking human',
      );

      // Resume same ACP session after nickname/L0 change + model change + autoApprove=true change!
      const b1 = r1.find((e) => e.nativeSessionBinding).nativeSessionBinding;
      l0Body = '## 1. 身份\n你是 闪闪·烁烁（v2）。';
      calls.length = 0;
      const s2 = makeAcpService({ model: 'gemini-4-carbon-high', autoApprove: true });
      const r2 = await collect(
        s2.invoke('Turn 2', {
          workingDirectory: workspace,
          sessionId: 'acp-conv-1',
          nativeSessionBinding: b1,
          auditContext: { userId: 'owner', threadId: 't1', invocationId: 'inv2', catId: 'gemini-argon' },
        }),
      );
      assert.equal(
        r2.some((e) => e.type === 'error'),
        false,
        JSON.stringify(r2),
      );
      const resumeCall = calls.find(([k]) => k === 'resume');
      assert.ok(resumeCall, 'must resume existing ACP session across L0/model/permission update');
      assert.equal(resumeCall[4].antigravity.systemPrompt.append, l0Body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('attributable pre-execution guard refusals preserve completed model reply, while unblocked or ordinary-error undeclared executions still fail closed', () => {
    const expected = {
      agentName: 'cat-cafe-host-gemini-carbon',
      spawnCwd: '/tmp',
      model: 'gemini-4-carbon-high',
      permissionMode: 'always-proceed',
    };
    const sessionId = verifiedInitSessionId(
      {
        conversation_id: 'conv-tools-1',
        init: {
          agent: expected.agentName,
          cwd: expected.spawnCwd,
          model: expected.model,
          permission_mode: 'always-proceed',
          tools: ['read_file', 'brand_new_1_6_tool'],
        },
      },
      expected,
      false,
    );
    assert.equal(sessionId, 'conv-tools-1');

    const projectSteps = (stepUpdates, response = 'Used standard tool instead.') => {
      const lines = [
        JSON.stringify({ event: 'init', conversation_id: 'conv-tools-1', init: { agent: expected.agentName } }),
        ...stepUpdates.map((step_update) => JSON.stringify({ event: 'step_update', step_update })),
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'conv-tools-1', status: 'SUCCESS', response },
        }),
      ];
      return projectAgyNativeTurn(
        'gemini-carbon',
        { provider: 'google', model: expected.model },
        { sessionId: 'conv-tools-1', turn: summarizeAgyStreamJsonTurn(lines), transportError: null },
        false,
        ['read_file'],
      );
    };

    // Positive 1: Direct host PreToolUse guard denial -> turn succeeds!
    const directGuardMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          error: { message: 'Clowder AI native guard: unknown or unqualified native operation: brand_new_1_6_tool' },
        },
      },
    ]);
    assert.equal(directGuardMessages.at(-1)?.errorCode, undefined);
    assert.equal(directGuardMessages.find((m) => m.type === 'text')?.content, 'Used standard tool instead.');

    // Positive 2: Real agy 1.5.9 CLI PreToolUse wire wrapper ("tool call denied by pre-tool hook: ...") -> turn succeeds!
    const wireWrappedGuardMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          error: {
            message:
              'tool call denied by pre-tool hook: Clowder AI native guard: unknown or unqualified native operation: brand_new_1_6_tool',
          },
        },
      },
    ]);
    assert.equal(wireWrappedGuardMessages.at(-1)?.errorCode, undefined);

    // Positive 3: Real agy 1.5.9 dispatcher pre-execution rejection of un-registered tool -> turn succeeds!
    const unknownToolDispatcherMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          error: { message: 'unknown tool: "brand_new_1_6_tool" — check spelling' },
        },
      },
    ]);
    assert.equal(unknownToolDispatcherMessages.at(-1)?.errorCode, undefined);

    // Counterexample A1: Undeclared tool executed with output and ordinary error -> MUST fail with AGY_UNEXPECTED_TOOL!
    const executedThenFailedMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          output: 'wrote artifact.txt; post-write check failed',
          error: { message: 'post-write check failed' },
        },
      },
    ]);
    assert.equal(executedThenFailedMessages.at(-1)?.errorCode, 'AGY_UNEXPECTED_TOOL');

    // Counterexample A2: Undeclared tool executed with empty output and ordinary runtime error -> MUST fail with AGY_UNEXPECTED_TOOL!
    const ordinaryRuntimeErrorMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          error: { message: 'EACCES: permission denied' },
        },
      },
    ]);
    assert.equal(ordinaryRuntimeErrorMessages.at(-1)?.errorCode, 'AGY_UNEXPECTED_TOOL');

    // Counterexample B1: ERROR followed by DONE retaining earlier errorMessage -> MUST fail with AGY_UNEXPECTED_TOOL!
    const errorThenDoneMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          error: { message: 'Clowder AI native guard: unknown or unqualified native operation: brand_new_1_6_tool' },
        },
      },
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          output: 'write completed successfully',
        },
      },
    ]);
    assert.equal(errorThenDoneMessages.at(-1)?.errorCode, 'AGY_UNEXPECTED_TOOL');

    // Counterexample B2: DONE followed by ERROR even with empty output and guard-looking text -> MUST fail with AGY_UNEXPECTED_TOOL!
    const doneThenErrorMessages = projectSteps([
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: { parameters: {} },
      },
      {
        conversation_id: 'conv-tools-1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'brand_new_1_6_tool',
        tool_info: {
          parameters: {},
          error: { message: 'Clowder AI native guard: unknown or unqualified native operation: brand_new_1_6_tool' },
        },
      },
    ]);
    assert.equal(doneThenErrorMessages.at(-1)?.errorCode, 'AGY_UNEXPECTED_TOOL');

    // Counterexample C: Unblocked execution (state: DONE, error: null) -> MUST fail with AGY_UNEXPECTED_TOOL!
    const unblockedMessages = projectSteps(
      [
        {
          conversation_id: 'conv-tools-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'brand_new_1_6_tool',
          tool_info: { parameters: {}, output: 'bypassed' },
        },
      ],
      'Bypassed.',
    );
    assert.equal(unblockedMessages.at(-1)?.errorCode, 'AGY_UNEXPECTED_TOOL');
  });

  test(
    'real agy CLI wire: genuine legacy frozen-agent session migrates without seal (old frozen body superseded, >30KB live rules refresh cleanly across turns without truncation), and autoApprove=true reaches 127.0.0.1 loopback',
    { timeout: 60_000, skip: !resolveCliCommand('agy') },
    async () => {
      const agyBinary = resolveCliCommand('agy');
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'f325-parity-s1-wire-')));
      const workspace = join(root, 'workspace');
      const homeRoot = join(root, 'profiles');
      mkdirSync(workspace, { recursive: true });

      let phase = 'init';
      let triggerLoopbackProbe = false;
      let loopbackHit = false;

      const probeTargetServer = createServer((_req, res) => {
        loopbackHit = true;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('LOOPBACK-OK');
      });
      probeTargetServer.listen(0, '127.0.0.1');
      await once(probeTargetServer, 'listening');
      const probeTargetUrl = `http://127.0.0.1:${probeTargetServer.address().port}/ping`;

      const wireRequests = [];
      let callOnce = false;
      const fakeGeminiServer = createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"models":[]}');
          return;
        }
        const body = JSON.parse(raw);
        wireRequests.push({
          phase,
          main: Boolean(body.tools),
          systemText: JSON.stringify(body.systemInstruction ?? body.system_instruction ?? {}),
          contentsText: JSON.stringify(body.contents ?? []),
        });
        let parts = [{ text: `WIRE-${phase}-OK` }];
        if (triggerLoopbackProbe && body.tools && !callOnce) {
          callOnce = true;
          parts = [
            {
              functionCall: {
                name: 'run_command',
                args: {
                  CommandLine: `node -e "fetch('${probeTargetUrl}').then(r=>r.text()).then(t=>console.log(t))"`,
                  toolSummary: 'Loopback test',
                  WaitMsBeforeAsync: 5000,
                },
              },
            },
          ];
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
            usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 5, totalTokenCount: 30 },
          })}\n\n`,
        );
      });
      fakeGeminiServer.listen(0, '127.0.0.1');
      await once(fakeGeminiServer, 'listening');
      const geminiBaseUrl = `http://127.0.0.1:${fakeGeminiServer.address().port}`;

      try {
        const profileConfig = {
          enabled: true,
          carrier: 'native',
          autoApprove: true,
          model: 'gemini-4-carbon-high',
          profileId: 'gemini-argon',
          homeRoot,
          trustedWorkspaces: [workspace],
        };

        const buildRealL0 = (nickname, restrictions, extraPaddingTag) => {
          const snapshot = captureFrozenL0Input({
            catId: 'gemini-carbon',
            projection: 'owner',
            installRoot: REPO_ROOT,
            overlayRoot: REPO_ROOT,
            dossierRoot: REPO_ROOT,
            profileDir: workspace,
            governanceText: `## 3. 家规\nRule 0: 边界内保留判断力。\n${Array.from({ length: 450 }, (_, i) => `- Governance clause ${extraPaddingTag}-${i + 1}: keep partner work unblocked and continuous across turns.`).join('\n')}\nTAIL-MARKER-${extraPaddingTag}`,
            member: {
              name: '暹罗猫 Gemini 4 Carbon',
              displayName: '暹罗猫',
              nickname,
              breedId: 'siamese',
              relationshipKey: 'siamese',
              roleDescription: 'AGY Native 独立成员',
              personality: '保留判断力',
              restrictions,
            },
            model: 'gemini-4-carbon-high',
            coCreator: { name: 'You', mentionPatterns: ['@co-creator'] },
            teammates: [],
          });
          return renderFrozenL0Input(snapshot);
        };

        const withSyntheticUpstream = (launch) => {
          const settingsIdx = launch.args.indexOf('--settings');
          const settingsFile = settingsIdx >= 0 ? launch.args[settingsIdx + 1] : null;
          assert.ok(settingsFile, 'must pass explicit per-run --settings');
          const original = readFileSync(settingsFile, 'utf8');
          writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), modelProvider: 'gemini' }), 'utf8');
          return (async function* () {
            try {
              yield* spawnCli({
                ...launch,
                timeoutMs: 30_000,
                env: {
                  ...launch.env,
                  AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
                  GEMINI_API_KEY: 'fake-wire-key',
                  GOOGLE_GEMINI_BASE_URL: geminiBaseUrl,
                  HTTP_PROXY: 'http://127.0.0.1:9',
                  HTTPS_PROXY: 'http://127.0.0.1:9',
                  ALL_PROXY: 'http://127.0.0.1:9',
                  NO_PROXY: '127.0.0.1,localhost',
                },
              });
            } finally {
              writeFileSync(settingsFile, original, 'utf8');
            }
          })();
        };

        // Turn 1 (legacy-v1): Create a genuine pre-PR legacy trajectory with hashed agent.md
        // containing frozen L0 identity + restriction directly in agent.md and zero rules files.
        phase = 'legacy-v1';
        const legacyFrozenBody = [
          '## 1. 身份与伙伴声明',
          '你是 暹罗猫/烁烁。',
          'OLD-LEGACY-FROZEN-IDENTITY',
          '**硬限制（高于一般路由建议）**：禁止写代码。',
          '',
          '## 3. 家规',
          'Rule 0: legacy v1 body.',
        ].join('\n');
        const legacyHash = createHash('sha256').update(legacyFrozenBody).digest('hex');
        const legacyAgentName = `cat-cafe-gemini-carbon-${legacyHash.slice(0, 16)}-auto`;
        const legacyTools = deduplicateAgyNativeFileTools(AGY_NATIVE_TOOLS);
        let legacyBinding;
        const seedPlan = await prepareAgyNativeLaunch({
          catId: 'gemini-carbon',
          model: 'gemini-4-carbon-high',
          workspace,
          profileConfig,
          prompt: 'LEGACY-PROMPT-1',
          body: legacyFrozenBody,
          command: agyBinary,
          options: { invocationId: 'inv-legacy-v1', spawnCliOverride: async function* () {} },
        });
        try {
          const geminiDirArg = seedPlan.cliOptions.args.find((a) => a.startsWith('--gemini_dir='));
          const runHome = dirname(geminiDirArg.slice('--gemini_dir='.length));
          rmSync(join(runHome, '.gemini/config/rules'), { recursive: true, force: true });
          const legacyAgentDir = join(runHome, '.gemini/config/agents', legacyAgentName);
          mkdirSync(legacyAgentDir, { recursive: true });
          const legacyAgentMarkdown = [
            '---',
            `name: ${legacyAgentName}`,
            'description: Clowder AI native identity',
            'mainAgent: true',
            'subagent: false',
            'inheritMcp: true',
            'tools:',
            ...legacyTools.map((t) => `  - ${t}`),
            '---',
            `${legacyFrozenBody}\n`,
          ].join('\n');
          writeFileSync(join(legacyAgentDir, 'agent.md'), legacyAgentMarkdown, { encoding: 'utf8', mode: 0o600 });
          const legacyArgs = [...seedPlan.cliOptions.args];
          legacyArgs[legacyArgs.indexOf('--agent') + 1] = legacyAgentName;
          const legacyEvents = await collect(withSyntheticUpstream({ ...seedPlan.cliOptions, args: legacyArgs }));
          const legacyInit = legacyEvents.find((e) => e.event === 'init');
          assert.ok(legacyInit?.conversation_id, 'legacy CLI turn must emit conversation_id');
          legacyBinding = {
            ...seedPlan.binding,
            cliSessionId: legacyInit.conversation_id,
            agentName: legacyAgentName,
            l0Hash: legacyHash,
          };
        } finally {
          await seedPlan.disposeCredentials();
        }
        const req1 = wireRequests.find((r) => r.phase === 'legacy-v1' && r.main);
        assert.ok(req1);
        assert.ok(req1.systemText.includes('OLD-LEGACY-FROZEN-IDENTITY'));

        // Turn 2 (migrated-v2): Resume that genuine legacy conversation via AgyNativeAgentService
        // with >30KB L0 V2 (new nickname, restriction lifted) + loopback tool execution.
        let currentBody = buildRealL0('碳碳·烁烁', [], 'V2');
        assert.ok(Buffer.byteLength(currentBody, 'utf8') > 30_000, 'test L0 must exceed 24KB single-rule file limit');

        const service = new AgyNativeAgentService({
          catId: 'gemini-carbon',
          command: agyBinary,
          profile: profileConfig,
          l0CompilerFn: async () => currentBody,
        });

        const runTurn = async (turnLabel, userPrompt, binding) => {
          phase = turnLabel;
          const events = await collect(
            service.invoke(userPrompt, {
              workingDirectory: workspace,
              invocationId: `inv-${turnLabel}`,
              ...(binding ? { sessionId: binding.cliSessionId, nativeSessionBinding: binding } : {}),
              spawnCliOverride: withSyntheticUpstream,
            }),
          );
          assert.equal(events.at(-1)?.errorCode, undefined, `${turnLabel}: ${JSON.stringify(events)}`);
          return events.find((e) => e.type === 'session_init')?.nativeSessionBinding;
        };

        triggerLoopbackProbe = true;
        callOnce = false;
        const b2 = await runTurn('migrated-v2', 'USER-PROMPT-2', legacyBinding);
        assert.equal(b2.cliSessionId, legacyBinding.cliSessionId, 'must resume same conversationId without sealing');
        assert.equal(b2.agentName, 'cat-cafe-host-gemini-carbon', 'must upgrade durable binding to stable host agent');
        const req2 = wireRequests.filter((r) => r.phase === 'migrated-v2' && r.main).at(-1);
        assert.ok(req2);
        assert.ok(!req2.systemText.includes('<truncated'), 'partitioned >30KB L0 must not be truncated');
        assert.ok(
          req2.systemText.includes('OLD-LEGACY-FROZEN-IDENTITY'),
          'carrier retains Turn-1 frozen agent.md text on a pre-existing legacy trajectory',
        );
        assert.ok(
          req2.systemText.includes('一律以本组当前规则为准'),
          'migrated turn must deliver explicit native supersession instruction in systemInstruction',
        );
        assert.ok(req2.systemText.includes('碳碳·烁烁'));
        assert.ok(req2.systemText.includes('TAIL-MARKER-V2'), 'tail of >30KB L0 V2 must arrive in systemInstruction');
        assert.ok(!req2.contentsText.includes('TAIL-MARKER-V2'), 'user contents must stay clean');
        assert.equal(loopbackHit, true, 'autoApprove=true run_command must connect to 127.0.0.1 without BypassSandbox');

        // Turn 3 (refreshed-v3): Update L0 from V2 -> V3 on the same conversation; verify old V2 live rules disappear!
        triggerLoopbackProbe = false;
        currentBody = buildRealL0('碳碳·烁烁·V3', ['仅用于验证V3规则送达'], 'V3');
        const b3 = await runTurn('refreshed-v3', 'USER-PROMPT-3', b2);
        assert.equal(b3.cliSessionId, legacyBinding.cliSessionId, 'must stay on same conversationId across V2->V3');
        const req3 = wireRequests.filter((r) => r.phase === 'refreshed-v3' && r.main).at(-1);
        assert.ok(req3);
        assert.ok(!req3.systemText.includes('<truncated'));
        assert.ok(req3.systemText.includes('碳碳·烁烁·V3'));
        assert.ok(req3.systemText.includes('仅用于验证V3规则送达'));
        assert.ok(req3.systemText.includes('TAIL-MARKER-V3'));
        assert.ok(
          !req3.systemText.includes('TAIL-MARKER-V2'),
          'prior V2 live always_on rules must disappear on Turn 3',
        );
        assert.ok(!req3.contentsText.includes('TAIL-MARKER-V3'), 'user contents must stay clean on Turn 3');
      } finally {
        fakeGeminiServer.closeAllConnections?.();
        probeTargetServer.closeAllConnections?.();
        await Promise.all([
          new Promise((done) => fakeGeminiServer.close(done)),
          new Promise((done) => probeTargetServer.close(done)),
        ]);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
