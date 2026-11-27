import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createAgentAdapterNativeProcess } from '../dist/domains/plugin/declared/agent-adapter-native-process.js';
import { setup } from './helpers/agent-adapter-archive.js';
import { startLayoutModel } from './helpers/f320-layout-model.mjs';

const archive = process.env.CLOWDER_CODEX_CANDIDATE_ARCHIVE;
const executable = process.env.CLOWDER_CODEX_CANDIDATE_EXECUTABLE;

test(
  'the independent Codex exec archive streams real turns and resumes its native history',
  {
    skip: !archive || !executable,
    timeout: 90_000,
  },
  async (t) => {
    assert.ok(isAbsolute(archive) && isAbsolute(executable));
    const ref = { pluginId: 'official.agent-codex', contributionId: 'codex' };
    const registry = new SessionImplementationRegistry();
    let approvedDigest;
    let establishedSession;
    const launches = [];
    const { runtime, manager } = await setup(t, registry, (request) => {
      if (
        request.pluginId !== ref.pluginId ||
        request.contributionId !== ref.contributionId ||
        request.packageDigest !== approvedDigest
      )
        return;
      if (request.action === 'detect')
        return {
          async inspect(signal) {
            const { stdout } = await promisify(execFile)(executable, ['--version'], {
              cwd: root,
              env,
              signal,
              timeout: 4_000,
              windowsHide: true,
            });
            const version = /^codex-cli\s+(\S+)/.exec(stdout)?.[1];
            assert.ok(version);
            return { status: 'ready', version };
          },
        };
      assert.equal(request.hostSession?.cwd, root);
      assert.equal(request.catId, 'fixture');
      if (request.action === 'openSession')
        return {
          async prepare(input) {
            return input.resumeNativeSessionId && input.resumeNativeSessionId === establishedSession
              ? { nativeSessionId: establishedSession }
              : {};
          },
        };
      if (request.action === 'startTurn')
        return {
          run: createAgentAdapterNativeProcess(({ args, stdin }) => {
            assert.equal(typeof stdin, 'string');
            const separator = args.indexOf('--');
            assert.ok(separator > 0);
            assert.ok(!args.includes(stdin));
            launches.push(args);
            return {
              command: executable,
              cwd: root,
              env,
              stdinInput: stdin,
              bindExecutionOwner: false,
              timeoutMs: 20_000,
              args: [
                ...args.slice(0, separator),
                '--skip-git-repo-check',
                '-c',
                'approval_policy="never"',
                ...args.slice(separator),
              ],
            };
          }),
        };
    });
    const root = runtime.projectRoot;
    const home = join(root, 'codex');
    await mkdir(home);
    const env = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.Path ? { Path: process.env.Path } : {}),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
      TEMP: root,
      TMP: root,
      NO_PROXY: '127.0.0.1,localhost',
    };
    const model = await startLayoutModel();
    t.after(() => model.close());
    await writeFile(
      join(home, 'config.toml'),
      [
        'cli_auth_credentials_store="file"',
        'model="fixture"',
        'model_provider="fixture"',
        'check_for_update_on_startup=false',
        'analytics.enabled=false',
        '[features]',
        'respect_system_proxy=false',
        'enable_request_compression=false',
        '[model_providers.fixture]',
        'name="Fixture"',
        `base_url=${JSON.stringify(model.url)}`,
        'wire_api="responses"',
        'requires_openai_auth=false',
        'supports_websockets=false',
        'request_max_retries=0',
        'stream_max_retries=0',
        '',
      ].join('\n'),
    );

    await manager.install({ source: { kind: 'local-archive', path: archive } });
    const { plugin } = await manager.get(ref.pluginId);
    approvedDigest = plugin.packageDigest;
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    const detected = await runtime.agentAdapters.detect(ref);
    assert.equal(detected.binding.packageDigest, approvedDigest);
    assert.equal(detected.candidates[0].state.status, 'ready');
    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const opts = { hostSessionId: 'host', systemPrompt: 'Short isolated role', workingDirectory: root };
    const first = await Array.fromAsync(service.invoke('F320_NATIVE_MEMORY', { ...opts, invocationId: 'first' }));
    assert.equal(
      first.find((value) => value.type === 'text')?.content,
      'LOCAL_LAYOUT_REPLY_1',
      first.find((value) => value.type === 'error')?.error,
    );
    const nativeSessionId = first.at(-1)?.metadata.sessionId;
    assert.ok(nativeSessionId);
    establishedSession = nativeSessionId;
    await service.releaseAll('reopen');
    const second = await Array.fromAsync(
      service.invoke('Continue the native chat', {
        ...opts,
        invocationId: 'second',
        sessionId: nativeSessionId,
      }),
    );
    await service.releaseAll('test_complete');
    assert.equal(second.find((value) => value.type === 'text')?.content, 'LOCAL_LAYOUT_REPLY_2');
    assert.equal(second.at(-1)?.metadata.sessionId, nativeSessionId);
    // Exec emits its native usage snapshot, including the previous turn on resume.
    assert.equal(first.at(-1)?.metadata.usage?.outputTokens, 2);
    assert.equal(second.at(-1)?.metadata.usage?.outputTokens, 4);
    assert.deepEqual(launches[1].slice(0, 3), ['exec', 'resume', nativeSessionId]);
    assert.equal(launches.length, 2);
    assert.equal(model.requests[1].nativeMemory, true);
    assert.equal(
      model.requests.some((request) => request.authorization),
      false,
    );
    t.diagnostic(
      `Independent archive ran Codex CLI ${detected.candidates[0].state.version} twice against the isolated model.`,
    );
  },
);
