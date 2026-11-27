import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { resolveCodexAccountLaunch } from '../dist/config/codex-account-launch.js';
import { captureCodexLaunchPolicy } from '../dist/config/codex-cli.js';
import {
  codexExecutionAccountSnapshot,
  codexGatewayCredentialVersion,
} from '../dist/config/codex-execution-account.js';
import { writeCredential } from '../dist/config/credentials.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createPluginManagerRuntimeComposition } from '../dist/domains/plugin/index.js';
import { setup } from './helpers/agent-adapter-archive.js';
import { startLayoutModel } from './helpers/f320-layout-model.mjs';

const archive = process.env.CLOWDER_CODEX_PRODUCT_CANDIDATE_ARCHIVE;

test(
  'catalog Codex exec starts and resumes through the default Host grant',
  { skip: !archive, timeout: 90000 },
  async (t) => {
    const registry = new SessionImplementationRegistry();
    const { runtime } = await setup(t, registry);
    const cwd = runtime.projectRoot;
    const previousConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = cwd;
    process.env.CAT_CAFE_DATA_DIR = join(cwd, 'isolated-data');
    t.after(() => {
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousConfigRoot;
      if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
    });
    const requests = [];
    const pendingRequest = Promise.withResolvers();
    const finishResponse = Promise.withResolvers();
    const model = await startLayoutModel({
      onRequest(body) {
        requests.push(body);
        if (requests.length !== 3) return;
        pendingRequest.resolve();
        return finishResponse.promise;
      },
    });
    t.after(() => model.close());
    const accountRef = 'isolated-codex-gateway';
    const apiKey = 'loopback-test-key';
    writeCatalogAccount(cwd, accountRef, { clientId: 'openai', authType: 'api_key', baseUrl: model.url });
    writeCredential(accountRef, { apiKey }, cwd);
    const account = resolveByAccountRef(cwd, accountRef);
    assert.equal(account?.apiKey, apiKey);
    const codexAccountLaunch = resolveCodexAccountLaunch(account, { cwd });
    const executionAccount = codexExecutionAccountSnapshot(account, codexAccountLaunch);

    const ref = { pluginId: 'official.agent-codex', contributionId: 'codex' };
    const bytes = await readFile(archive);
    const entry = {
      catalogId: 'agent-codex',
      packageName: '@clowder-ai/agent-codex',
      version: '0.1.0-alpha.1',
      pluginId: ref.pluginId,
      distribution: 'registry',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/agent-codex/-/agent-codex-0.1.0-alpha.1.tgz',
      packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogManifests: [
        {
          pluginId: ref.pluginId,
          version: entry.version,
          contractVersion: '0.4.0-candidate.0',
          name: 'Codex',
          features: [{ id: 'codex', name: 'Codex', resources: [] }],
          runtime: { transport: 'builtin', entrypoint: 'src/index.mjs', dataDirectory: 'agent-codex' },
        },
      ],
      catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 0 }) },
      fetchOfficialArchive: async () => bytes,
      threads: { get: () => null },
    });
    await manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    const { plugin } = await manager.get(ref.pluginId);
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    assert.equal(
      (await runtime.inventoryStore.readCurrentAuthority(ref.pluginId))?.packageRecord?.provenance?.kind,
      'catalog',
    );
    const detection = await runtime.agentAdapters.detect(ref);
    assert.equal(detection.candidates[0]?.state.status, 'ready');

    const service = new RegisteredSessionAgentService({ catId: 'isolated-codex', ref, registry });
    assert.equal(service.forInvocation().usesSessionInstructions, true);
    const options = {
      hostSessionId: 'fixture-host-session',
      workingDirectory: cwd,
      systemPrompt: 'An isolated role for Codex',
      executionAccount,
      codexAccountLaunch,
      codexGatewayCredentialVersion: codexGatewayCredentialVersion(model.url, apiKey),
      codexLaunchPolicy: { ...captureCodexLaunchPolicy(), sandboxMode: 'read-only', approvalPolicy: 'never' },
      executionPreferences: { model: 'fixture', effort: '', nativeAuthentication: false },
    };
    const read = (messages, text) => {
      assert.equal(messages.at(-1)?.errorCode, undefined, messages.find((message) => message.type === 'error')?.error);
      assert.equal(messages.find((message) => message.type === 'text')?.content, text);
      return messages.at(-1)?.metadata.sessionId;
    };
    const first = await Array.fromAsync(service.invoke('F320_NATIVE_MEMORY', { ...options, invocationId: 'first' }));
    const sessionId = read(first, 'LOCAL_LAYOUT_REPLY_1');
    assert.ok(sessionId);
    await service.releaseAll('reopen');
    const second = await Array.fromAsync(
      service.invoke('Continue the chat', { ...options, invocationId: 'second', sessionId, requireExactResume: true }),
    );
    assert.equal(read(second, 'LOCAL_LAYOUT_REPLY_2'), sessionId);
    assert.equal(model.requests[1].nativeMemory, true);
    assert.ok(model.requests.every(({ authorization }) => authorization));
    for (const request of requests) {
      assert.ok(
        JSON.stringify({
          instructions: request.instructions,
          input: request.input.filter(({ role }) => role !== 'user'),
        }).includes(options.systemPrompt),
      );
      assert.ok(!JSON.stringify(request.input.filter(({ role }) => role === 'user')).includes(options.systemPrompt));
    }
    const otherWorkspace = await Array.fromAsync(
      service.invoke('Keep the current binding in its own workspace', {
        ...options,
        invocationId: 'other-workspace',
        workingDirectory: join(cwd, 'other-workspace'),
        sessionId,
      }),
    );
    assert.ok(otherWorkspace.at(-1)?.errorCode);
    assert.equal(model.requests.length, 2);
    const cancellation = new AbortController();
    const cancelled = Array.fromAsync(
      service.invoke('Wait for an answer', {
        ...options,
        invocationId: 'cancel',
        sessionId,
        signal: cancellation.signal,
      }),
    );
    try {
      await Promise.race([
        pendingRequest.promise,
        cancelled.then(() => assert.fail('The turn ended before it reached the model')),
        new Promise((resolve) => AbortSignal.timeout(15_000).addEventListener('abort', resolve, { once: true })).then(
          () => assert.fail('The model did not receive the cancellable turn'),
        ),
      ]);
      cancellation.abort();
      const events = await cancelled;
      assert.equal(events.filter((event) => event.type === 'done').length, 1);
      assert.equal(events.at(-1)?.errorCode, 'cancelled');
      assert.ok(!events.some((event) => event.type === 'text'));
    } finally {
      finishResponse.resolve();
    }
    const afterCancel = await Array.fromAsync(
      service.invoke('Continue after cancelling', { ...options, invocationId: 'after-cancel', sessionId }),
    );
    assert.equal(read(afterCancel, 'LOCAL_LAYOUT_REPLY_4'), sessionId);
    writeCredential(accountRef, { apiKey: 'rotated-loopback-key' }, cwd);
    const rejected = await Array.fromAsync(
      service.invoke('Do not start a process', { ...options, invocationId: 'rotated', sessionId }),
    );
    assert.ok(rejected.at(-1)?.errorCode);
    assert.equal(model.requests.length, 4);
    t.diagnostic(`Catalog archive ran Codex CLI ${detection.candidates[0].state.version} through the default Host grant.`);
  },
);
