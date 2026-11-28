import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { writeCredential } from '../dist/config/credentials.js';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createPluginManagerRuntimeComposition } from '../dist/domains/plugin/index.js';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_KIMI_CANDIDATE_ARCHIVE;
const ref = { pluginId: 'official.agent-kimi', contributionId: 'kimi' };

test(
  'Kimi print opens and resumes through the default catalog Host grant',
  {
    skip: !archive,
    timeout: 90_000,
  },
  async (t) => {
    const registry = new SessionImplementationRegistry();
    const { runtime } = await setup(t, registry);
    const root = runtime.projectRoot;
    for (const [key, value] of [
      ['CAT_CAFE_GLOBAL_CONFIG_ROOT', root],
      ['CAT_CAFE_CONFIG_ROOT', root],
      ['CAT_CAFE_DATA_DIR', join(root, 'isolated-data')],
    ]) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }

    const requests = [];
    const key = 'isolated-kimi-fixture-key';
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
      requests.push({ body, selectedKey: request.headers.authorization === 'Bearer ' + key });
      const reply = 'isolated-kimi-reply-' + requests.length;
      const chunk = { id: reply, object: 'chat.completion.chunk', created: 1, model: body.model };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const fields of [
        { delta: { role: 'assistant', content: reply }, finish_reason: null },
        { delta: {}, finish_reason: 'stop' },
      ]) {
        response.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, ...fields }] }) + '\n\n');
      }
      response.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    );
    const accountRef = 'isolated-kimi-gateway';
    writeCatalogAccount(root, accountRef, {
      clientId: 'kimi',
      authType: 'api_key',
      baseUrl: 'http://127.0.0.1:' + server.address().port,
    });
    writeCredential(accountRef, { apiKey: key }, root);
    const profile = resolveByAccountRef(root, accountRef);
    assert.equal(profile?.apiKey === key, true);

    const workspace = join(root, 'workspace');
    const marker = join(root, 'workspace-mcp-started');
    await mkdir(join(workspace, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workspace, '.kimi-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            transport: 'stdio',
            command: process.execPath,
            args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker],
          },
        },
      }),
    );
    const bytes = await readFile(archive);
    const entry = {
      catalogId: 'agent-kimi',
      packageName: '@clowder-ai/agent-kimi',
      version: '0.1.0-alpha.2',
      pluginId: ref.pluginId,
      distribution: 'registry',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/agent-kimi/-/agent-kimi-0.1.0-alpha.2.tgz',
      packageDigest: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    };
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogManifests: [
        {
          pluginId: ref.pluginId,
          version: entry.version,
          contractVersion: '0.4.0-candidate.0',
          name: 'Kimi Code',
          features: [{ id: 'kimi', name: 'Kimi Code', resources: [] }],
          runtime: { transport: 'builtin', entrypoint: 'src/index.mjs', dataDirectory: 'agent-kimi' },
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
    const detection = await runtime.agentAdapters.detect(ref);
    assert.equal(detection.candidates[0]?.state.status, 'ready');
    t.diagnostic('Real Kimi CLI ' + detection.candidates[0].state.version);

    const member = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const model = 'isolated-kimi-model';
    const identity = 'KIMI_HOST_ROLE_FIXTURE';
    const binding = freezeExecutionAccountBinding({
      catId: 'fixture',
      catConfig: {
        id: 'fixture',
        name: 'Kimi fixture',
        displayName: 'Kimi fixture',
        roleDescription: identity,
        personality: '',
        avatar: '/fixture.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@fixture'],
        clientId: 'acp',
        carrier: 'acp',
        configurationSource: 'native_tool',
        accountRef,
        agentProvider: 'plugin:official.agent-kimi/kimi',
        defaultModel: model,
        mcpSupport: false,
      },
      workspace: { workingDirectory: workspace, usesDefaultWorkspace: false },
    });
    assert.equal(binding.executionAccount?.accountRef, accountRef);
    assert.equal(binding.projectRoot, root);
    const prepared = [];
    const options = {
      hostSessionId: 'isolated-kimi-host-session',
      workingDirectory: workspace,
      systemPrompt: identity,
      executionAccountProjectRoot: root,
      executionAccount: binding.executionAccount,
      executionPreferences: binding.executionPreferences,
      signal: t.signal,
      async beforeProviderLaunch(request) {
        assert.equal(JSON.stringify(request).includes(key), false);
        assert.equal(prepared.length, requests.length);
        prepared.push(request.message.body);
        return { requestGenerationId: 'record-' + prepared.length, generationOrdinal: 1, sessionId: 'fixture' };
      },
    };
    const firstText = 'KIMI_HOST_FIRST_FIXTURE';
    const first = await Array.fromAsync(member.invoke(firstText, { ...options, invocationId: 'first' }));
    assert.equal(first.at(-1)?.errorCode, undefined, first.find(({ type }) => type === 'error')?.error);
    assert.equal(first.find(({ type }) => type === 'text')?.content, 'isolated-kimi-reply-1');
    const sessionId = first.at(-1)?.metadata?.sessionId;
    assert.match(sessionId, /^(?:session_)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    await member.releaseAll('reopen');
    const resumedOptions = { ...options, sessionId, requireExactResume: true };
    const secondText = 'KIMI_HOST_SECOND_FIXTURE';
    const resumed = await Array.fromAsync(member.invoke(secondText, { ...options, sessionId, invocationId: 'resume' }));
    assert.equal(resumed.at(-1)?.errorCode, undefined, resumed.find(({ type }) => type === 'error')?.error);
    assert.equal(resumed.find(({ type }) => type === 'text')?.content, 'isolated-kimi-reply-2');
    assert.equal(resumed.at(-1)?.metadata?.sessionId, sessionId);

    assert.deepEqual(prepared, [firstText, secondText]);
    assert.equal(requests.length, 2);
    for (const { body, selectedKey } of requests) {
      assert.equal(selectedKey, true);
      assert.equal(body.model, model);
      assert.match(JSON.stringify(body.messages.filter(({ role }) => role === 'system')), /KIMI_HOST_ROLE_FIXTURE/);
      assert.doesNotMatch(
        JSON.stringify(body.messages.filter(({ role }) => role === 'user')),
        /KIMI_HOST_ROLE_FIXTURE/,
      );
      assert.deepEqual(body.tools ?? [], []);
    }
    assert.match(JSON.stringify(requests[1].body.messages), /KIMI_HOST_FIRST_FIXTURE/);
    assert.match(JSON.stringify(requests[1].body.messages), /isolated-kimi-reply-1/);
    assert.equal(existsSync(marker), false);
    const otherWorkspace = join(root, 'other-workspace');
    await mkdir(otherWorkspace);
    const wrongWorkspace = await Array.fromAsync(
      member.invoke('Do not move the bound workspace', {
        ...resumedOptions,
        invocationId: 'changed-workspace',
        workingDirectory: otherWorkspace,
      }),
    );
    assert.ok(wrongWorkspace.at(-1)?.errorCode);
    assert.ok(
      (
        await Array.fromAsync(
          member.invoke('Do not resume with a changed role', {
            ...resumedOptions,
            invocationId: 'changed-role',
            systemPrompt: 'KIMI_CHANGED_ROLE_FIXTURE',
          }),
        )
      ).at(-1)?.errorCode,
    );
    await member.releaseAll('credential-rotation');
    writeCredential(accountRef, { apiKey: 'isolated-kimi-rotated-key' }, root);
    assert.ok(
      (
        await Array.fromAsync(
          member.invoke('Do not use a changed credential', {
            ...resumedOptions,
            invocationId: 'changed-credential',
          }),
        )
      ).at(-1)?.errorCode,
    );
    assert.equal(requests.length, 2);
    await member.releaseAll('done');
    t.diagnostic(
      'Catalog first turn and ordinary same-ID resume reached the isolated gateway. Role and credential changes did not.',
    );
  },
);
