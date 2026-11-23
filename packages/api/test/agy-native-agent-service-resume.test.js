import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { freezeL0Input, L0_COMPILER_VERSION, renderFrozenL0Input } from '@cat-cafe/shared/l0-input';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);
const { NATIVE_AUTH_CONTINUATION_PROMPT } = await import(
  '../dist/domains/cats/services/agents/invocation/native-auth-continuation.js'
);
const { resolveCliCommand } = await import('../dist/utils/cli-resolve.js');
const { spawnCli } = await import('../dist/utils/cli-spawn.js');

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-resume-'));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  let nativeBody = '# Identity\nL0-v1\n';
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
    },
    command: '/usr/bin/true',
    l0CompilerFn: async () => nativeBody,
  });
  return {
    base,
    workspace,
    service,
    setNativeBody: (body) => {
      nativeBody = body;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function collect(iterable) {
  const result = [];
  for await (const event of iterable) result.push(event);
  return result;
}

function fakeSpawn(launches, conversationId, model = 'gemini-3.8-flash-high') {
  return async function* (options) {
    launches.push(options);
    const agent = options.args[options.args.indexOf('--agent') + 1];
    const cwd = options.cwd;
    const permissionMode = options.args.includes('--dangerously-skip-permissions')
      ? 'always-proceed'
      : 'request-review';
    yield {
      event: 'init',
      conversation_id: conversationId,
      init: { agent, cwd, model, permission_mode: permissionMode, tools: [] },
    };
    yield {
      event: 'result',
      result: { conversation_id: conversationId, status: 'SUCCESS', response: 'OK\n', num_turns: 1 },
    };
  };
}

describe('F325 native AGY session binding', () => {
  test('migrates legacy hashed bindings and resumes across guidance, nickname and governance edits without sealing', async () => {
    const f = fixture();
    try {
      const body =
        '# Identity\nFixed identity.\n\n## 7. MCP 工具 quick index\nTOOLS-OLD\n\n## 8. 家里能力唤醒指南\nCAPABILITY-OLD\n\n## 9. 代码哲学\nRule v1.\n';
      f.setNativeBody(body);
      const launches = [];
      const prepared = [];
      const run = (binding) =>
        collect(
          f.service.invoke('current turn', {
            workingDirectory: f.workspace,
            beforeProviderLaunch: async (req) => {
              prepared.push(req);
            },
            ...(binding ? { sessionId: binding.cliSessionId, nativeSessionBinding: binding } : {}),
            spawnCliOverride: fakeSpawn(launches, 'session-guidance'),
          }),
        );
      const first = await run();
      const firstBinding = first.find((event) => event.type === 'session_init').nativeSessionBinding;
      const oldHash = createHash('sha256').update(body.trim()).digest('hex');
      const legacy = {
        ...firstBinding,
        l0Hash: oldHash,
        agentName: `cat-cafe-gemini38-${oldHash.slice(0, 16)}`,
      };
      const migrated = await run(legacy);
      assert.equal(migrated.at(-1).errorCode, undefined);
      const binding = migrated.find((event) => event.type === 'session_init').nativeSessionBinding;
      assert.equal(binding.agentName, 'cat-cafe-host-gemini38');

      f.setNativeBody(body.replaceAll('-OLD', '-NEW').replace('Rule v1.', 'Rule v2.'));
      const resumed = await run(binding);
      assert.equal(resumed.at(-1).errorCode, undefined);
      assert.deepEqual(launches[2].args.slice(-2), ['--conversation', 'session-guidance']);
      assert.equal(JSON.parse(launches[2].stdinInput).message.content[0].text, 'current turn');
      assert.match(prepared.at(-1).nativeInstructions[0].body, /TOOLS-NEW[\s\S]*CAPABILITY-NEW[\s\S]*Rule v2\./);

      // Foreign cat binding MUST still be rejected before spawning
      const foreign = await run({ ...binding, agentName: 'cat-cafe-other-cat-0123456789abcdef' });
      assert.equal(foreign.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, 3, 'foreign-cat mismatches must not launch the provider');
    } finally {
      f.cleanup();
    }
  });

  test('resumes with verified binding across L0 updates and read_only policy while rejecting missing bindings', async () => {
    const f = fixture();
    try {
      const launches = [];
      const first = await collect(
        f.service.invoke('one', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nL0-v1\n',
          spawnCliOverride: fakeSpawn(launches, 'session-one'),
        }),
      );
      assert.equal(first.at(-1).errorCode, undefined);
      const init = first.find((event) => event.type === 'session_init');
      assert.equal(init.sessionId, 'session-one');
      assert.ok(init.nativeSessionBinding);
      const second = await collect(
        f.service.invoke('two', {
          workingDirectory: f.workspace,
          sessionId: 'session-one',
          nativeSessionBinding: init.nativeSessionBinding,
          spawnCliOverride: fakeSpawn(launches, 'session-one'),
        }),
      );
      assert.equal(second.at(-1).errorCode, undefined);
      assert.deepEqual(launches[1].args.slice(-2), ['--conversation', 'session-one']);
      assert.equal(
        launches[1].args[launches[1].args.indexOf('--agent') + 1],
        launches[0].args[launches[0].args.indexOf('--agent') + 1],
      );

      const missing = await collect(
        f.service.invoke('missing binding', {
          workingDirectory: f.workspace,
          sessionId: init.sessionId,
          spawnCliOverride: fakeSpawn(launches, 'must-not-launch'),
        }),
      );
      assert.equal(missing.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, 2, 'missing binding must not launch the provider');

      f.setNativeBody('# Identity\nL0-v2\n');
      const third = await collect(
        f.service.invoke('three', {
          workingDirectory: f.workspace,
          sessionId: 'session-one',
          nativeSessionBinding: init.nativeSessionBinding,
          spawnCliOverride: fakeSpawn(launches, 'session-one'),
        }),
      );
      assert.equal(third.at(-1).errorCode, undefined);

      const readOnlyTurn = await collect(
        f.service.invoke('read only', {
          workingDirectory: f.workspace,
          sessionId: init.sessionId,
          nativeSessionBinding: third.find((e) => e.type === 'session_init').nativeSessionBinding,
          toolExecutionPolicy: { mode: 'read_only' },
          spawnCliOverride: fakeSpawn(launches, 'session-one'),
        }),
      );
      assert.equal(readOnlyTurn.at(-1).errorCode, undefined);
      assert.equal(launches.length, 4);
    } finally {
      f.cleanup();
    }
  });

  test('rejects an init that silently selects another model', async () => {
    const f = fixture();
    try {
      const events = await collect(
        f.service.invoke('hello', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nL0-v1\n',
          spawnCliOverride: fakeSpawn([], 'wrong-model-session', 'another-model'),
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events[0].errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events[0].error, /model/i);
    } finally {
      f.cleanup();
    }
  });

  test('resumes across teammate roster, owner capsule, nickname and restriction updates while keeping user prompt and auth continuation clean', async () => {
    const f = fixture();
    try {
      const launches = [];
      const l0V1 = [
        '## 1. 身份与伙伴声明',
        '',
        '你是 暹罗猫/烁烁。',
        '**硬限制**：禁止写代码。',
        '## 主人画像',
        '',
        '默认中文。',
        '',
        '你不是一个孤立的工具——你是协作团队的一员。',
        '',
        '## 队友名册',
        '| 猫猫 | @mention · 当前模型 | 路由边界 |',
        '|------|---------|------|',
        '| 布偶猫 Dot | @dot · claude-opus-5-5-high | — |',
        '',
        '---',
        '',
        '## 3. 家规',
        'Rule 0: 边界内保留判断力。',
      ].join('\n');
      f.setNativeBody(l0V1);

      const preparedRequests = [];
      const first = await collect(
        f.service.invoke('turn 1', {
          workingDirectory: f.workspace,
          beforeProviderLaunch: async (req) => {
            preparedRequests.push(req);
          },
          spawnCliOverride: fakeSpawn(launches, 'session-roster-1'),
        }),
      );
      assert.equal(first.at(-1).errorCode, undefined);
      const init1 = first.find((event) => event.type === 'session_init');
      assert.ok(init1?.nativeSessionBinding);
      const turn1StdinText = JSON.parse(launches[0].stdinInput).message.content[0].text;
      assert.equal(turn1StdinText, 'turn 1');
      assert.equal(preparedRequests[0].message.body, 'turn 1');
      assert.match(preparedRequests[0].nativeInstructions[0].body, /默认中文。/);
      assert.match(preparedRequests[0].nativeInstructions[0].body, /@dot/);

      const legacyFullHash = createHash('sha256').update(l0V1).digest('hex');
      const legacyBinding = {
        ...init1.nativeSessionBinding,
        l0Hash: legacyFullHash,
        agentName: `cat-cafe-gemini38-${legacyFullHash.slice(0, 16)}-auto`,
      };

      const secondFromLegacy = await collect(
        f.service.invoke('turn 2 from legacy binding', {
          workingDirectory: f.workspace,
          sessionId: 'session-roster-1',
          nativeSessionBinding: legacyBinding,
          spawnCliOverride: fakeSpawn(launches, 'session-roster-1'),
        }),
      );
      assert.equal(secondFromLegacy.at(-1).errorCode, undefined);
      assert.deepEqual(launches[1].args.slice(-2), ['--conversation', 'session-roster-1']);
      const migratedInit = secondFromLegacy.find((event) => event.type === 'session_init');
      assert.equal(migratedInit.nativeSessionBinding.agentName, 'cat-cafe-host-gemini38');

      // Update nickname, unlock restriction, edit capsule & roster -> resumes hot with fresh nativeInstructions!
      const l0V2Updated = l0V1
        .replace('你是 暹罗猫/烁烁。', '你是 暹罗猫/碳碳·烁烁。')
        .replace('**硬限制**：禁止写代码。\n', '')
        .replace('默认中文。', '默认中文；最近在给新猫开工位。')
        .replace('| 布偶猫 Dot | @dot · claude-opus-5-5-high | — |', '| 缅因猫 Sol | @codex61-sol · gpt-6.1-sol | — |');
      f.setNativeBody(l0V2Updated);

      const thirdHot = await collect(
        f.service.invoke('turn 3 hot after full config update', {
          workingDirectory: f.workspace,
          sessionId: 'session-roster-1',
          nativeSessionBinding: migratedInit.nativeSessionBinding,
          beforeProviderLaunch: async (req) => {
            preparedRequests.push(req);
          },
          spawnCliOverride: fakeSpawn(launches, 'session-roster-1'),
        }),
      );
      assert.equal(thirdHot.at(-1).errorCode, undefined);
      assert.deepEqual(launches[2].args.slice(-2), ['--conversation', 'session-roster-1']);
      assert.equal(JSON.parse(launches[2].stdinInput).message.content[0].text, 'turn 3 hot after full config update');
      assert.match(preparedRequests[1].nativeInstructions[0].body, /碳碳·烁烁/);
      assert.match(preparedRequests[1].nativeInstructions[0].body, /默认中文；最近在给新猫开工位。/);
      assert.match(preparedRequests[1].nativeInstructions[0].body, /@codex61-sol/);
      assert.ok(!preparedRequests[1].nativeInstructions[0].body.includes('@dot'));
      assert.ok(!preparedRequests[1].nativeInstructions[0].body.includes('禁止写代码'));

      // In-invocation OAuth continuation prompt MUST preserve exact NATIVE_AUTH_CONTINUATION_PROMPT body
      let authContinuationPrepared;
      const authContEvents = await collect(
        f.service.invoke(NATIVE_AUTH_CONTINUATION_PROMPT, {
          workingDirectory: f.workspace,
          sessionId: 'session-roster-1',
          nativeSessionBinding: migratedInit.nativeSessionBinding,
          beforeProviderLaunch: async (req) => {
            authContinuationPrepared = req;
          },
          spawnCliOverride: fakeSpawn(launches, 'session-roster-1'),
        }),
      );
      assert.equal(authContEvents.at(-1).errorCode, undefined);
      assert.equal(authContinuationPrepared.message.body, NATIVE_AUTH_CONTINUATION_PROMPT);
    } finally {
      f.cleanup();
    }
  });

  test(
    'real agy CLI loopback wire: refreshes identity, nickname, capsule, roster and guidance natively in systemInstruction on --conversation hot resume',
    { timeout: 60_000, skip: !resolveCliCommand('agy') },
    async () => {
      const agyBinary = resolveCliCommand('agy');
      const root = mkdtempSync(join(tmpdir(), 'f325-agy-wire-hot-l0-'));
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      let activePhase = 'init';
      const wireRequests = [];
      const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"models":[]}');
          return;
        }
        const body = JSON.parse(raw);
        wireRequests.push({
          phase: activePhase,
          main: Boolean(body.tools),
          systemText: JSON.stringify(body.systemInstruction ?? body.system_instruction ?? {}),
          contents: body.contents ?? [],
          contentsText: JSON.stringify(body.contents ?? []),
        });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'WIRE-OK' }] }, finishReason: 'STOP', index: 0 }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 },
          })}\n\n`,
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');

      const buildFrozen = (nickname, capsule, roster, guidanceRevision) =>
        freezeL0Input({
          schemaVersion: 1,
          compilerVersion: L0_COMPILER_VERSION,
          catId: 'gemini38',
          projection: 'owner',
          template:
            '## 1. 身份与伙伴声明\n\n{{IDENTITY_BLOCK}}\n{{USER_CAPSULE}}\n\n{{TEAMMATE_ROSTER}}\n\n---\n\n{{GOVERNANCE_L0}}\n\n## 7. MCP 工具 quick index（cat-cafe-* 工具家族）\n\n{{L5_CONTENT}}\n\n---\n\n## 8. Clowder AI 家里独有能力唤醒指南（场景→skill 触发反射）\n\n{{L6_CONTENT}}\n\n---\n\n## 9. 代码哲学\nRetain binding rules.\n',
          sections: { L5_CONTENT: `TOOLS-${guidanceRevision}`, L6_CONTENT: `CAPABILITY-${guidanceRevision}` },
          variables: {
            IDENTITY_BLOCK: `你是 暹罗猫/${nickname}。\n**硬限制**：禁止触碰 6399。`,
            USER_CAPSULE: `## 主人画像\n\n${capsule}`,
            TEAMMATE_ROSTER: [
              '## 队友名册',
              '| 猫猫 | @mention · 当前模型 | 路由边界 |',
              '|------|---------|------|',
              `| ${roster} | @peer · gpt-6.1-sol | — |`,
            ].join('\n'),
            GOVERNANCE_L0: '## 3. 家规\nRule 0: 边界内保留判断力。',
          },
        });

      try {
        for (const mode of ['markdown', 'frozen']) {
          let currentFrozen = buildFrozen('NICK-OLD', 'CAPSULE-OLD', 'ROSTER-OLD', 'OLD');
          const homeRoot = join(root, `profiles-${mode}`);
          const service = new AgyNativeAgentService({
            catId: 'gemini38',
            command: agyBinary,
            profile: {
              enabled: true,
              autoApprove: true,
              model: 'gemini-3.8-flash-high',
              profileId: `gemini38-${mode}`,
              homeRoot,
            },
            l0CompilerFn: async ({ frozenInput }) => renderFrozenL0Input(frozenInput ?? currentFrozen),
          });

          const runWireTurn = async (phaseLabel, promptText, binding, frozenOverride) => {
            activePhase = `${mode}-${phaseLabel}`;
            const events = [];
            for await (const event of service.invokeWithContinuityPreflight(
              {
                settle: async () => ({ prompt: promptText, promptGenerationId: `gen-${activePhase}` }),
              },
              {
                workingDirectory: workspace,
                invocationId: `inv-${activePhase}`,
                ...(frozenOverride ? { frozenL0Input: frozenOverride } : {}),
                ...(binding
                  ? { sessionId: binding.cliSessionId, nativeSessionBinding: binding, requireExactResume: true }
                  : {}),
                spawnCliOverride: async function* (launch) {
                  const settingsIdx = launch.args.indexOf('--settings');
                  const settingsFile =
                    settingsIdx >= 0
                      ? launch.args[settingsIdx + 1]
                      : join(launch.env.HOME, '.gemini/antigravity-cli/settings.json');
                  const original = readFileSync(settingsFile, 'utf8');
                  writeFileSync(
                    settingsFile,
                    JSON.stringify({ ...JSON.parse(original), modelProvider: 'gemini' }),
                    'utf8',
                  );
                  try {
                    yield* spawnCli({
                      ...launch,
                      timeoutMs: 30_000,
                      env: {
                        ...launch.env,
                        AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
                        GEMINI_API_KEY: `fake-${mode}`,
                        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`,
                        HTTP_PROXY: 'http://127.0.0.1:9',
                        HTTPS_PROXY: 'http://127.0.0.1:9',
                        ALL_PROXY: 'http://127.0.0.1:9',
                        NO_PROXY: '127.0.0.1,localhost',
                      },
                    });
                  } finally {
                    writeFileSync(settingsFile, original, 'utf8');
                  }
                },
              },
            )) {
              events.push(event);
            }
            assert.equal(events.at(-1)?.errorCode, undefined, `${activePhase}: ${JSON.stringify(events)}`);
            return events.find((e) => e.type === 'session_init')?.nativeSessionBinding;
          };

          const bindingTurn1 = await runWireTurn(
            'turn1',
            'CURRENT-TURN-1',
            undefined,
            mode === 'frozen' ? currentFrozen : undefined,
          );
          assert.ok(bindingTurn1?.cliSessionId);
          const turn1Main = wireRequests.find((r) => r.phase === `${mode}-turn1` && r.main);
          assert.ok(turn1Main, `${mode} turn1 must hit synthetic Gemini upstream`);
          assert.match(turn1Main.systemText, /NICK-OLD/);
          assert.match(turn1Main.systemText, /CAPSULE-OLD/);
          assert.match(turn1Main.systemText, /ROSTER-OLD/);
          assert.match(turn1Main.systemText, /TOOLS-OLD/);
          assert.match(turn1Main.systemText, /CAPABILITY-OLD/);
          assert.ok(!turn1Main.contentsText.includes('CAPSULE-OLD'), 'user message stays clean without L0');

          currentFrozen = buildFrozen('NICK-NEW', 'CAPSULE-NEW', 'ROSTER-NEW', 'NEW');
          const bindingTurn2 = await runWireTurn(
            'turn2',
            'CURRENT-TURN-2',
            bindingTurn1,
            mode === 'frozen' ? currentFrozen : undefined,
          );
          assert.equal(bindingTurn2.cliSessionId, bindingTurn1.cliSessionId, `${mode} must keep same conversationId`);

          const turn2Main = wireRequests.find((r) => r.phase === `${mode}-turn2` && r.main);
          assert.ok(turn2Main, `${mode} turn2 must hit synthetic Gemini upstream`);
          assert.match(turn2Main.systemText, /NICK-NEW/);
          assert.match(turn2Main.systemText, /CAPSULE-NEW/);
          assert.match(turn2Main.systemText, /ROSTER-NEW/);
          assert.match(turn2Main.systemText, /TOOLS-NEW/);
          assert.match(turn2Main.systemText, /CAPABILITY-NEW/);
          assert.doesNotMatch(turn2Main.systemText, /NICK-OLD|CAPSULE-OLD|ROSTER-OLD|TOOLS-OLD|CAPABILITY-OLD/);
          assert.doesNotMatch(turn2Main.contentsText, /NICK-NEW|CAPSULE-NEW|ROSTER-NEW|TOOLS-NEW|CAPABILITY-NEW/);
        }
      } finally {
        server.closeAllConnections?.();
        await new Promise((done) => server.close(done));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
