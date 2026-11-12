import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { spawnCli } from '../dist/utils/cli-spawn.js';

const USERINFO_EOF_STDERR = 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF\n';
const MODEL = 'gemini-3.8-flash-high';

const root = mkdtempSync(join(tmpdir(), 'agy-preinit-retry-'));
const savedEnv = Object.fromEntries(
  [
    'HOME',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'AUDIT_LOG_DIR',
    'CAT_CAFE_DATA_DIR',
    'CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT',
  ].map((key) => [key, process.env[key]]),
);
process.env.HOME = root;
process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
process.env.AUDIT_LOG_DIR = join(root, 'audit');
process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';

let invokeSingleCat,
  isTransientAgyNativePreInitFailure,
  AgyNativeAgentService,
  SessionChainStore,
  SessionSealer,
  TranscriptWriter,
  ContextEpochOwner,
  InMemoryContextEpochStore,
  resolveInvocationCapacitySnapshot;

before(async () => {
  ({ invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'));
  ({ isTransientAgyNativePreInitFailure } = await import(
    '../dist/domains/cats/services/agents/invocation/invoke-helpers.js'
  ));
  ({ AgyNativeAgentService } = await import(
    '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
  ));
  ({ SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
  ({ SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js'));
  ({ TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js'));
  ({ ContextEpochOwner } = await import('../dist/domains/cats/services/session/context/ContextEpochOwner.js'));
  ({ InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js'));
  ({ resolveInvocationCapacitySnapshot } = await import(
    '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
  ));
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function createHostEnv(caseName) {
  const base = mkdtempSync(join(root, `${caseName}-`));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace);
  const threadId = `thread-${caseName}`;
  const chain = new SessionChainStore();
  const writer = new TranscriptWriter({ dataDir: join(base, 'transcripts') });
  const epochOwner = new ContextEpochOwner(new InMemoryContextEpochStore());
  let runtimeSessionId;
  let invCounter = 0;

  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      autoApprove: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: MODEL,
    },
    l0CompilerFn: async () => '# Identity\nFixture cat.\n',
    rawArchive: { append: async () => {} },
  });

  const deps = {
    registry: {
      create: () => ({
        invocationId: `inv-${caseName}-${++invCounter}`,
        callbackToken: `tok-${invCounter}`,
      }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => runtimeSessionId,
      store: async (_u, _c, _t, id) => {
        runtimeSessionId = id;
      },
      delete: async () => {
        runtimeSessionId = undefined;
      },
      resolveWorkingDirectory: () => workspace,
    },
    sessionChainStore: chain,
    transcriptWriter: writer,
    sessionSealer: new SessionSealer(chain, writer),
    contextEpochOwner: epochOwner,
    threadStore: {
      get: async () => ({ projectPath: workspace, createdBy: 'owner' }),
      updateParticipantActivity: async () => {},
    },
    apiUrl: 'http://127.0.0.1:3102',
  };

  const actualInvokeWithPreflight = service.invokeWithContinuityPreflight.bind(service);

  async function invokeTurn(promptText, spawnAttemptFn) {
    const launches = [];
    const stdinWrites = [];
    let factoryCalls = 0;
    service.invokeWithContinuityPreflight = (preflight, options) =>
      actualInvokeWithPreflight(preflight, {
        ...options,
        spawnCliOverride: (launch) => {
          const attemptNumber = launches.length + 1;
          launches.push(launch);
          const wrappedLaunch = {
            ...launch,
            onStdinReady: (writerFn) => {
              launch.onStdinReady?.((payload) => {
                stdinWrites.push({ attempt: attemptNumber, payload });
                return writerFn(payload);
              });
            },
          };
          return spawnAttemptFn(attemptNumber, wrappedLaunch);
        },
      });

    const capacitySnapshot = await resolveInvocationCapacitySnapshot({
      catId: 'gemini38',
      threadId,
      service,
      sessionChainStore: chain,
    });

    const messages = [];
    for await (const msg of invokeSingleCat(deps, {
      catId: 'gemini38',
      service,
      prompt: promptText,
      threadId,
      userId: 'owner',
      isLastCat: true,
      capacitySnapshot,
      contextPromptFactory: async () => {
        factoryCalls++;
        return { prompt: promptText, promptMessageIds: [], deltaSize: 'small' };
      },
      rebuildPromptAfterSessionSeal: async () => 'COLD_REBUILD_SHOULD_NOT_RUN',
    })) {
      messages.push(msg);
    }

    const active = await chain.getActive('gemini38', threadId, 'owner');
    if (active) {
      await writer.flush({
        sessionId: active.id,
        threadId,
        catId: active.catId,
        seq: active.seq,
      });
    }
    return { launches, stdinWrites, factoryCalls, messages, active };
  }

  return { base, workspace, threadId, chain, invokeTurn };
}

function writeFailingPreInitScript(dir, name, stderrText, exitCode = 1) {
  const script = join(dir, `${name}.cjs`);
  writeFileSync(script, `process.stderr.write(${JSON.stringify(stderrText)}); process.exitCode = ${exitCode};\n`);
  return script;
}

function successfulInitAndReplyStream(conversationId, responseText) {
  return async function* (launch) {
    let writtenPrompt = null;
    launch.onStdinReady?.((value) => {
      writtenPrompt = value;
    });
    yield {
      event: 'init',
      conversation_id: conversationId,
      init: {
        agent: launch.args[launch.args.indexOf('--agent') + 1],
        cwd: launch.cwd,
        model: MODEL,
        permission_mode: 'always-proceed',
      },
    };
    assert.ok(writtenPrompt, 'verified init must settle and write prompt bytes once');
    yield {
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 1,
        step_type: 'agent_response',
        state: 'DONE',
        text: responseText,
      },
    };
    yield {
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'SUCCESS',
        response: responseText,
        num_turns: 1,
      },
    };
  };
}

test('fresh turn + hot-resumed turn: pre-init oauth2/v2/userinfo EOF exit 1 retries once without dropping session binding or duplicating prompt', async () => {
  const host = await createHostEnv('userinfo-eof-recovery');
  const eofScript = writeFailingPreInitScript(host.base, 'eof-preinit', USERINFO_EOF_STDERR, 1);

  // 1) Fresh turn: Attempt 1 spawns real child exiting 1 on userinfo EOF; Attempt 2 succeeds.
  const fresh = await host.invokeTurn('Turn 1 hello', (attempt, launch) => {
    if (attempt === 1) {
      return spawnCli({ ...launch, command: process.execPath, args: [eofScript] });
    }
    return successfulInitAndReplyStream('native-conv-1', 'Fresh turn recovered')(launch);
  });

  assert.equal(fresh.launches.length, 2, 'fresh pre-init userinfo EOF must retry once');
  assert.equal(fresh.factoryCalls, 1, 'prompt generation must settle only once (on Attempt 2)');
  assert.equal(fresh.stdinWrites.length, 1, 'zero stdin prompt bytes may be written on failed Attempt 1');
  assert.equal(fresh.stdinWrites[0].attempt, 2);
  assert.equal(fresh.messages.filter((m) => m.type === 'error').length, 0);
  assert.equal(fresh.messages.find((m) => m.type === 'text')?.content, 'Fresh turn recovered');
  assert.equal(fresh.messages.at(-1)?.type, 'done');
  assert.equal(fresh.messages.at(-1)?.errorCode, undefined);
  assert.equal(fresh.active?.cliSessionId, 'native-conv-1');

  // 2) Hot-resumed turn: Attempt 1 fails pre-init with userinfo EOF on --conversation native-conv-1;
  //    Attempt 2 MUST keep --conversation native-conv-1 (not wipe session!) and deliver cleanly.
  const resumed = await host.invokeTurn('Turn 2 follow-up', (attempt, launch) => {
    const convIdx = launch.args.indexOf('--conversation');
    assert.notEqual(convIdx, -1, `Attempt ${attempt} must pass --conversation`);
    assert.equal(
      launch.args[convIdx + 1],
      'native-conv-1',
      `Attempt ${attempt} must preserve existing native conversation binding`,
    );
    if (attempt === 1) {
      return spawnCli({ ...launch, command: process.execPath, args: [eofScript] });
    }
    return successfulInitAndReplyStream('native-conv-1', 'Resumed turn recovered')(launch);
  });

  assert.equal(resumed.launches.length, 2, 'resumed pre-init userinfo EOF must retry once');
  assert.equal(resumed.factoryCalls, 1, 'resumed turn must settle prompt generation only once');
  assert.equal(resumed.stdinWrites.length, 1, 'resumed turn must write prompt only on Attempt 2');
  assert.equal(resumed.messages.filter((m) => m.type === 'error').length, 0);
  assert.equal(resumed.messages.find((m) => m.type === 'text')?.content, 'Resumed turn recovered');
  assert.equal(resumed.active?.cliSessionId, 'native-conv-1');
});

test('unclassified pre-init exit 1 (signal null) retries once, while exhausted retry preserves cliDiagnostics', async () => {
  const host = await createHostEnv('unclassified-and-exhausted');
  const unknownScript = writeFailingPreInitScript(
    host.base,
    'unknown-preinit',
    'transient runtime bootstrap glitch\n',
    1,
  );
  const eofScript = writeFailingPreInitScript(host.base, 'eof-both', USERINFO_EOF_STDERR, 1);

  const recovered = await host.invokeTurn('Unclassified transient turn', (attempt, launch) => {
    if (attempt === 1) {
      return spawnCli({ ...launch, command: process.execPath, args: [unknownScript] });
    }
    return successfulInitAndReplyStream('native-conv-2', 'Recovered from unclassified exit 1')(launch);
  });
  assert.equal(recovered.launches.length, 2);
  assert.equal(recovered.messages.filter((m) => m.type === 'error').length, 0);
  assert.equal(recovered.messages.find((m) => m.type === 'text')?.content, 'Recovered from unclassified exit 1');

  // Both attempts fail with userinfo EOF -> surfaces humanized 网络连接失败 + full cliDiagnostics
  const exhausted = await host.invokeTurn('Both attempts fail', (_attempt, launch) =>
    spawnCli({ ...launch, command: process.execPath, args: [eofScript] }),
  );
  assert.equal(exhausted.launches.length, 2, 'must stop after 1 retry (2 attempts total)');
  assert.equal(exhausted.factoryCalls, 0, 'neither failed pre-init attempt may settle a prompt');
  const errorMsg = exhausted.messages.find((m) => m.type === 'error');
  assert.ok(errorMsg, 'exhausted retry must surface terminal error');
  assert.equal(errorMsg.errorCode, 'AGY_NATIVE_PREFLIGHT');
  assert.equal(errorMsg.error, '网络连接失败');
  assert.equal(errorMsg.metadata?.cliDiagnostics?.reasonCode, 'network_error');
  assert.equal(errorMsg.metadata?.cliDiagnostics?.debugRef?.exitCode, 1);
  assert.match(errorMsg.metadata?.cliDiagnostics?.safeExcerpt ?? '', /oauth2\/v2\/userinfo/);
});

test('deterministic pre-init rejections, signal kills, and post-init failures never trigger pre-init transient retry', async () => {
  assert.equal(typeof isTransientAgyNativePreInitFailure, 'function');

  for (const nonRetryableReason of [
    'auth_failed',
    'model_not_found',
    'invalid_config',
    'incompatible_cli_arguments',
    'upstream_policy_reject',
    'quota_exceeded',
    'context_window_exceeded',
    'spawn_failed',
    'cli_response_timeout',
    'session_not_found',
  ]) {
    assert.equal(
      isTransientAgyNativePreInitFailure({
        errorCode: 'AGY_NATIVE_PREFLIGHT',
        metadata: {
          cliDiagnostics: {
            reasonCode: nonRetryableReason,
            publicSummary: 'fixture',
            publicHint: 'fixture',
            debugRef: { command: 'agy', exitCode: 1, signal: null },
          },
        },
      }),
      false,
      `${nonRetryableReason} must not be treated as transient pre-init failure`,
    );
  }

  // Signal-killed pre-init process must not be treated as transient exit-1
  assert.equal(
    isTransientAgyNativePreInitFailure({
      errorCode: 'AGY_NATIVE_PREFLIGHT',
      metadata: {
        cliDiagnostics: {
          reasonCode: 'network_error',
          publicSummary: '网络连接失败',
          publicHint: 'fixture',
          debugRef: { command: 'agy', exitCode: null, signal: 'SIGTERM' },
        },
      },
    }),
    false,
  );

  // End-to-end negative 1: pre-init auth_failed (exitCode 1) -> 1 attempt only
  const authHost = await createHostEnv('auth-no-retry');
  const authScript = writeFailingPreInitScript(authHost.base, 'auth-fail', '401 Unauthorized\n', 1);
  const authRun = await authHost.invokeTurn('Auth failure turn', (_attempt, launch) =>
    spawnCli({ ...launch, command: process.execPath, args: [authScript] }),
  );
  assert.equal(authRun.launches.length, 1, 'pre-init auth_failed must NOT retry');
  assert.equal(authRun.messages.find((m) => m.type === 'error')?.metadata?.cliDiagnostics?.reasonCode, 'auth_failed');

  // End-to-end negative 2: post-init classified network_error (prompt already sent, AGY_NATIVE_FAILED) -> 1 attempt only
  const postInitHost = await createHostEnv('post-init-no-retry');
  const postInitRun = await postInitHost.invokeTurn('Post-init failure turn', async function* (_attempt, launch) {
    launch.onStdinReady?.(() => {});
    yield {
      event: 'init',
      conversation_id: 'native-post-init',
      init: {
        agent: launch.args[launch.args.indexOf('--agent') + 1],
        cwd: launch.cwd,
        model: MODEL,
        permission_mode: 'always-proceed',
      },
    };
    yield {
      __cliError: true,
      exitCode: 1,
      signal: null,
      command: 'agy',
      message: 'CLI 异常退出 (code: 1, signal: none)',
      reasonCode: 'network_error',
      cliDiagnostics: {
        reasonCode: 'network_error',
        publicSummary: '网络连接失败',
        publicHint: 'fixture',
        debugRef: { command: 'agy', exitCode: 1, signal: null },
      },
    };
  });
  assert.equal(postInitRun.launches.length, 1, 'post-init classified failure must NEVER retry (prompt already sent)');
  assert.equal(postInitRun.stdinWrites.length, 1);
  assert.equal(postInitRun.messages.find((m) => m.type === 'error')?.errorCode, 'AGY_NATIVE_FAILED');

  // End-to-end negative 3 (R1 regression): real child process emits valid init, receives stdin prompt,
  // then exits 1 with unclassified stderr -> msg.error matches legacy "CLI 异常退出 (code: 1, signal: none)"
  // with errorCode === 'AGY_NATIVE_FAILED'. Must NOT bypass pre-init gate or resend delivered prompt.
  const postInitUnknownHost = await createHostEnv('post-init-unknown-real-child');
  const postInitUnknownRun = await postInitUnknownHost.invokeTurn('Prompt already delivered', (_attempt, launch) => {
    const script = join(postInitUnknownHost.base, 'post-init-exit.cjs');
    const init = {
      event: 'init',
      conversation_id: 'native-post-init-unknown',
      init: {
        agent: launch.args[launch.args.indexOf('--agent') + 1],
        cwd: launch.cwd,
        model: MODEL,
        permission_mode: 'always-proceed',
      },
    };
    writeFileSync(
      script,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(init)}\n`)});\n` +
        'process.stdin.once("data", () => { process.stderr.write("unclassified provider crash\\n"); process.stdin.destroy(); });\n' +
        'process.exitCode = 1;\n',
    );
    return spawnCli({ ...launch, command: process.execPath, args: [script] });
  });
  assert.equal(postInitUnknownRun.launches.length, 1, 'post-init unclassified exit 1 must NEVER retry');
  assert.equal(postInitUnknownRun.stdinWrites.length, 1, 'delivered prompt must NOT be written twice');
  assert.equal(postInitUnknownRun.factoryCalls, 1, 'prompt factory must settle only once');
  assert.equal(postInitUnknownRun.messages.find((m) => m.type === 'error')?.errorCode, 'AGY_NATIVE_FAILED');

  // End-to-end negative 4 (sibling audit): post-init failure whose formatted error contains ACP-like
  // "ECONNRESET" text with errorCode === 'AGY_NATIVE_FAILED' must also NOT bypass the pre-init gate.
  const postInitAcpTextHost = await createHostEnv('post-init-econnreset-no-retry');
  const postInitAcpTextRun = await postInitAcpTextHost.invokeTurn(
    'Prompt delivered before socket drop',
    async function* (_attempt, launch) {
      launch.onStdinReady?.(() => {});
      yield {
        event: 'init',
        conversation_id: 'native-post-init-econnreset',
        init: {
          agent: launch.args[launch.args.indexOf('--agent') + 1],
          cwd: launch.cwd,
          model: MODEL,
          permission_mode: 'always-proceed',
        },
      };
      yield {
        __cliError: true,
        exitCode: 1,
        signal: null,
        command: 'agy',
        message: 'read ECONNRESET',
      };
    },
  );
  assert.equal(postInitAcpTextRun.launches.length, 1, 'post-init ECONNRESET text must NEVER retry on AGY Native');
  assert.equal(postInitAcpTextRun.stdinWrites.length, 1);
  assert.equal(postInitAcpTextRun.messages.find((m) => m.type === 'error')?.errorCode, 'AGY_NATIVE_FAILED');
});
