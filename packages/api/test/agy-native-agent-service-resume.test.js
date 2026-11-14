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
    yield {
      event: 'init',
      conversation_id: conversationId,
      init: { agent, cwd, model, permission_mode: 'request-review', tools: [] },
    };
    yield {
      event: 'result',
      result: { conversation_id: conversationId, status: 'SUCCESS', response: 'OK\n', num_turns: 1 },
    };
  };
}

describe('F325 native AGY session binding', () => {
  test('resumes only with the verified binding; missing binding or identity drift requires router rebuilding', async () => {
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

      f.setNativeBody('# Identity\nL0-v2\n');
      const third = await collect(
        f.service.invoke('three', {
          workingDirectory: f.workspace,
          sessionId: 'session-one',
          nativeSessionBinding: init.nativeSessionBinding,
          systemPrompt: '# Identity\nL0-v2\n',
          spawnCliOverride: fakeSpawn(launches, 'session-three'),
        }),
      );
      assert.equal(third.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      f.setNativeBody('# Identity\nL0-v1\n');
      const permissionChange = await collect(
        f.service.invoke('read only', {
          workingDirectory: f.workspace,
          sessionId: init.sessionId,
          nativeSessionBinding: init.nativeSessionBinding,
          toolExecutionPolicy: { mode: 'read_only' },
          spawnCliOverride: fakeSpawn(launches, 'must-not-launch'),
        }),
      );
      assert.equal(permissionChange.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, 2, 'service never silently replaces a mismatched session');
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

  test('resumes across teammate roster and owner capsule updates (including legacy full-hash bindings) while rejecting own restriction drift', async () => {
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
      assert.match(turn1StdinText, /默认中文。/);
      assert.match(turn1StdinText, /@dot/);
      assert.match(turn1StdinText, /turn 1$/);
      assert.equal(preparedRequests[0].message.body, turn1StdinText);
      assert.ok(!preparedRequests[0].nativeInstructions[0].body.includes('@dot'));

      // Simulate legacy pre-fix SessionRecord whose l0Hash/agentName hashed the full L0 string
      const legacyFullHash = createHash('sha256').update(l0V1).digest('hex');
      const agentPrefix = 'cat-cafe-gemini38-';
      const agentSuffix = init1.nativeSessionBinding.agentName.slice(agentPrefix.length + 16);
      const legacyBinding = {
        ...init1.nativeSessionBinding,
        l0Hash: legacyFullHash,
        agentName: `${agentPrefix}${legacyFullHash.slice(0, 16)}${agentSuffix}`,
      };

      // First turn after upgrade with matching full L0 migrates legacy binding to canonical l0Hash without sealing
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
      assert.equal(migratedInit.nativeSessionBinding.l0Hash, init1.nativeSessionBinding.l0Hash);

      // Teammate @dot removed + owner capsule edited -> MUST resume session-roster-1 hot AND deliver NEW values!
      const l0V2RosterAndCapsuleChanged = l0V1
        .replace('默认中文。', '默认中文；最近在给新猫开工位。')
        .replace('| 布偶猫 Dot | @dot · claude-opus-5-5-high | — |', '| 缅因猫 Sol | @codex61-sol · gpt-6.1-sol | — |');
      f.setNativeBody(l0V2RosterAndCapsuleChanged);

      const thirdHot = await collect(
        f.service.invoke('turn 3 hot after roster and capsule update', {
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
      const turn3StdinText = JSON.parse(launches[2].stdinInput).message.content[0].text;
      assert.match(turn3StdinText, /默认中文；最近在给新猫开工位。/);
      assert.match(turn3StdinText, /@codex61-sol/);
      assert.ok(!turn3StdinText.includes('@dot'));
      assert.match(turn3StdinText, /turn 3 hot after roster and capsule update$/);
      assert.equal(preparedRequests[1].message.body, turn3StdinText);

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

      // Removing own restriction (**硬限制**：禁止写代码。) MUST trigger AGY_NATIVE_RESUME_MISMATCH
      const l0V3RestrictionUnlocked = l0V2RosterAndCapsuleChanged.replace('**硬限制**：禁止写代码。\n', '');
      f.setNativeBody(l0V3RestrictionUnlocked);
      const fourthMismatch = await collect(
        f.service.invoke('turn 4 after unlocking code restriction', {
          workingDirectory: f.workspace,
          sessionId: 'session-roster-1',
          nativeSessionBinding: migratedInit.nativeSessionBinding,
          spawnCliOverride: fakeSpawn(launches, 'must-not-launch'),
        }),
      );
      assert.equal(fourthMismatch.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, 4);
    } finally {
      f.cleanup();
    }
  });

  test(
    'real agy CLI loopback wire: delivers updated USER_CAPSULE and TEAMMATE_ROSTER on --conversation hot resume in Markdown and frozenL0Input paths',
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

      const buildFrozen = (capsule, roster) =>
        freezeL0Input({
          schemaVersion: 1,
          compilerVersion: L0_COMPILER_VERSION,
          catId: 'gemini38',
          projection: 'owner',
          template:
            '## 1. 身份与伙伴声明\n\n{{IDENTITY_BLOCK}}\n{{USER_CAPSULE}}\n\n{{TEAMMATE_ROSTER}}\n\n---\n\n{{GOVERNANCE_L0}}\n',
          sections: {},
          variables: {
            IDENTITY_BLOCK: '你是 暹罗猫/烁烁。\n**硬限制**：禁止触碰 6399。',
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
          let currentFrozen = buildFrozen('CAPSULE-OLD', 'ROSTER-OLD');
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
                  const settingsFile = join(launch.env.HOME, '.gemini/antigravity-cli/settings.json');
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
          assert.match(turn1Main.systemText, /禁止触碰 6399/);
          assert.ok(
            !turn1Main.systemText.includes('CAPSULE-OLD'),
            `${mode} systemInstruction must not freeze CAPSULE-OLD`,
          );
          assert.ok(
            !turn1Main.systemText.includes('ROSTER-OLD'),
            `${mode} systemInstruction must not freeze ROSTER-OLD`,
          );
          const turn1UserEntry = JSON.stringify(
            turn1Main.contents.find((entry) => JSON.stringify(entry).includes('CURRENT-TURN-1')) ?? {},
          );
          assert.match(turn1UserEntry, /CAPSULE-OLD/);
          assert.match(turn1UserEntry, /ROSTER-OLD/);
          assert.match(turn1UserEntry, /CURRENT-TURN-1/);

          currentFrozen = buildFrozen('CAPSULE-NEW', 'ROSTER-NEW');
          const bindingTurn2 = await runWireTurn(
            'turn2',
            'CURRENT-TURN-2',
            bindingTurn1,
            mode === 'frozen' ? currentFrozen : undefined,
          );
          assert.equal(bindingTurn2.cliSessionId, bindingTurn1.cliSessionId, `${mode} must keep same conversationId`);
          assert.equal(bindingTurn2.l0Hash, bindingTurn1.l0Hash, `${mode} must keep same canonical l0Hash`);

          const turn2Main = wireRequests.find((r) => r.phase === `${mode}-turn2` && r.main);
          assert.ok(turn2Main, `${mode} turn2 must hit synthetic Gemini upstream`);
          assert.ok(
            !turn2Main.systemText.includes('CAPSULE-OLD'),
            `${mode} turn2 systemInstruction has no CAPSULE-OLD`,
          );
          assert.ok(!turn2Main.systemText.includes('ROSTER-OLD'), `${mode} turn2 systemInstruction has no ROSTER-OLD`);
          assert.match(turn2Main.contentsText, /CAPSULE-NEW/, `${mode} turn2 wire request must contain CAPSULE-NEW`);
          assert.match(turn2Main.contentsText, /ROSTER-NEW/, `${mode} turn2 wire request must contain ROSTER-NEW`);
          const turn2UserEntry = JSON.stringify(
            turn2Main.contents.find((entry) => JSON.stringify(entry).includes('CURRENT-TURN-2')) ?? {},
          );
          assert.match(turn2UserEntry, /CAPSULE-NEW/, `${mode} turn2 user message must deliver CAPSULE-NEW to model`);
          assert.match(turn2UserEntry, /ROSTER-NEW/, `${mode} turn2 user message must deliver ROSTER-NEW to model`);
          assert.match(turn2UserEntry, /CURRENT-TURN-2/);
          assert.ok(!turn2UserEntry.includes('CAPSULE-OLD'));
          assert.ok(!turn2UserEntry.includes('ROSTER-OLD'));
        }
      } finally {
        server.closeAllConnections?.();
        await new Promise((done) => server.close(done));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
