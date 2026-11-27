import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';

const archive = process.env.CLOWDER_KIMI_CANDIDATE_ARCHIVE;
const executable = process.env.CLOWDER_KIMI_CANDIDATE_EXECUTABLE;

test(
  'standalone Kimi archive loads across repositories and uses a scoped native grant',
  {
    skip: !archive || !executable,
    timeout: 45_000,
  },
  async (t) => {
    assert.ok(isAbsolute(archive) && isAbsolute(executable));
    const temp = resolve(tmpdir());
    const projectRoot = await mkdtemp(join(temp, 'kimi-adapter-cross-repo-'));
    const ref = { pluginId: 'official.agent-kimi', contributionId: 'kimi' };
    const registry = new SessionImplementationRegistry();
    const observedAt = Date.parse('2026-11-27T00:00:00Z');
    const calls = [];
    let approvedDigest;
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
      contract: { manifestContractRange: '0.4.0-candidate.0', validateManifest },
      agentSessionImplementations: registry,
      grantAgentAdapterNativeRuntime(request) {
        if (
          !approvedDigest ||
          request.packageDigest !== approvedDigest ||
          request.pluginId !== ref.pluginId ||
          request.contributionId !== ref.contributionId
        )
          return;
        if (request.action === 'detect')
          return {
            async inspect(signal) {
              const { stdout, stderr } = await promisify(execFile)(executable, ['--version'], {
                cwd: projectRoot,
                env: {
                  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                  TEMP: projectRoot,
                  TMP: projectRoot,
                  HOME: projectRoot,
                  USERPROFILE: projectRoot,
                  KIMI_CODE_HOME: projectRoot,
                },
                timeout: 4000,
                windowsHide: true,
                signal,
              });
              const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(stdout || stderr)?.[0];
              assert.ok(version, 'No version was returned by the actual Kimi CLI');
              return { status: 'ready', version };
            },
          };
        if (request.action === 'quota')
          return {
            terminal: {
              async capture(input) {
                assert.deepEqual(input, { submit: '/usage' });
                calls.push('terminal');
                return { output: '5h limit 25% used\r\nweekly limit 90% left', observedAt };
              },
            },
          };
        assert.equal(request.catId, 'fixture');
        if (request.action === 'openSession')
          return {
            async prepare(input) {
              assert.equal(input.resumeNativeSessionId, 'legacy-native');
              return { nativeSessionId: 'legacy-native' };
            },
          };
        if (request.action === 'startTurn')
          return {
            async run(input) {
              assert.deepEqual(input.args, [
                '--output-format',
                'stream-json',
                '--session',
                'legacy-native',
                '-p',
                'continue',
              ]);
              return (async function* () {
                yield {
                  kind: 'record',
                  value: {
                    role: 'assistant',
                    content: 'portable driver fixture',
                    session_id: 'legacy-native',
                    usage: { input_tokens: 3, output_tokens: 4 },
                  },
                };
                yield { kind: 'exit', code: 0 };
              })();
            },
          };
      },
    });
    t.after(async () => {
      await runtime.shutdown();
      assert.equal(dirname(projectRoot), temp);
      await rm(projectRoot, { recursive: true, force: true });
    });
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogManifests: [],
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
    });
    await manager.install({ source: { kind: 'local-archive', path: archive } });
    const { plugin } = await manager.get(ref.pluginId);
    approvedDigest = plugin.packageDigest;
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    const status = await runtime.agentAdapters.detect(ref);
    assert.equal(status.candidates[0].state.status, 'ready');
    assert.equal(status.binding.packageDigest, approvedDigest);
    t.diagnostic(`Actual Kimi CLI version ${status.candidates[0].state.version}; turn and quota use synthetic IO`);
    const quota = await runtime.agentAdapters.quota(ref);
    assert.equal(quota.observation.observedAt, observedAt);
    assert.deepEqual(
      quota.observation.windows.map(({ id, used }) => [id, used]),
      [
        ['kimi-rate-limit', 0.25],
        ['kimi-weekly', 0.1],
      ],
    );
    assert.equal(quota.binding.packageDigest, approvedDigest);
    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    assert.equal(service.implementationSnapshot().key, 'plugin:official.agent-kimi/kimi');
    const messages = await Array.fromAsync(
      service.invoke('continue', {
        hostSessionId: 'host-fixture',
        sessionId: 'legacy-native',
        invocationId: 'kimi-fixture-turn',
      }),
    );
    assert.equal(messages.find((item) => item.type === 'text')?.content, 'portable driver fixture');
    assert.equal(messages.at(-1)?.metadata.sessionId, 'legacy-native');
    assert.equal(messages.at(-1)?.errorCode, undefined, messages.find((item) => item.type === 'error')?.error);
    assert.equal(messages.at(-1)?.metadata.usage?.outputTokens, 4);
    const { plugin: enabled } = await manager.get(ref.pluginId);
    await manager.setEnabled(ref.pluginId, { enabled: false, expectedRevision: enabled.lifecycleRevision });
    assert.equal(registry.has(ref), false);
    await assert.rejects(runtime.agentAdapters.quota(ref), /not active/i);
    assert.deepEqual(calls, ['terminal']);
  },
);
