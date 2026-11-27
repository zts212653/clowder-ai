import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { claudeExecutionAccountSnapshot } from '../dist/config/claude-token-account.js';
import { writeCredential } from '../dist/config/credentials.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createPluginManagerRuntimeComposition } from '../dist/domains/plugin/index.js';
import { grantAgentAdapterNativeRuntime } from '../dist/domains/plugin/declared/agent-adapter-native-grant.js';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_CLAUDE_CANDIDATE_ARCHIVE;
const ref = { pluginId: 'official.agent-claude-code', contributionId: 'claude-code' };

function loopbackServer(handled) {
  return createServer(async (request, response) => {
    const chunks = await Array.fromAsync(request);
    if (request.url?.endsWith('/count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    if (!request.url?.includes('/v1/messages')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    handled.push({ body, apiKey: request.headers['x-api-key'] });
    const text = 'host-loopback-claude-reply-' + handled.length;
    const usage = { input_tokens: 12, output_tokens: 4 };
    const message = {
      id: 'msg_host_fixture_' + handled.length,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
      { type: 'message_stop' },
    ]) {
      response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    }
    response.end();
  });
}

test(
  'Claude Code print uses the default Host grant and preserves its native session',
  {
    skip: !archive,
    timeout: 180_000,
  },
  async (t) => {
    const startedAt = performance.now();
    const registry = new SessionImplementationRegistry();
    const { runtime } = await setup(t, registry);
    const root = runtime.projectRoot;
    for (const [key, value] of [
      ['CAT_CAFE_GLOBAL_CONFIG_ROOT', root],
      ['CAT_CAFE_DATA_DIR', join(root, 'isolated-data')],
    ]) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }

    const handled = [];
    const server = loopbackServer(handled);
    server.listen({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    t.after(
      () =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    );
    const apiKey = 'isolated-claude-key';
    const accountRef = 'isolated-claude-gateway';
    writeCatalogAccount(root, accountRef, {
      clientId: 'anthropic',
      authType: 'api_key',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });
    writeCredential(accountRef, { apiKey }, root);
    const profile = resolveByAccountRef(root, accountRef);
    assert.equal(profile?.apiKey, apiKey);

    const bytes = await readFile(archive);
    const entry = {
      catalogId: 'agent-claude-code',
      packageName: '@clowder-ai/agent-claude-code',
      version: '0.1.0-alpha.1',
      pluginId: ref.pluginId,
      distribution: 'registry',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/agent-claude-code/-/agent-claude-code-0.1.0-alpha.1.tgz',
      packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogManifests: [
        {
          pluginId: ref.pluginId,
          version: entry.version,
          contractVersion: '0.4.0-candidate.0',
          name: 'Claude Code',
          features: [{ id: 'claude-code', name: 'Claude Code', resources: [] }],
          runtime: { transport: 'builtin', entrypoint: 'src/index.mjs', dataDirectory: 'agent-claude-code' },
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
    assert.equal(detection.candidates[0]?.state.status, 'ready', JSON.stringify(detection.candidates[0]));
    assert.equal(detection.binding.ref, 'plugin:official.agent-claude-code/claude-code');
    t.diagnostic(`Catalog install and detection complete at ${Math.round(performance.now() - startedAt)} ms`);

    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const prepared = [];
    const updatedIdentity = 'CLAUDE_HOST_UPDATED_IDENTITY_FIXTURE';
    const options = {
      hostSessionId: 'isolated-claude-host-session',
      workingDirectory: root,
      systemPrompt: 'CLAUDE_HOST_IDENTITY_FIXTURE',
      executionAccountProjectRoot: root,
      executionAccount: claudeExecutionAccountSnapshot(profile),
      signal: t.signal,
      executionPreferences: { model: 'claude-sonnet-4-6', effort: '', nativeAuthentication: false },
      async beforeProviderLaunch(request) {
        assert.equal(prepared.length, handled.length);
        assert.equal(JSON.stringify(request).includes(apiKey), false);
        assert.equal(
          request.nativeInstructions[0]?.body,
          request.message.body === 'CLAUDE_HOST_NEW_ROLE_FIXTURE' ? updatedIdentity : options.systemPrompt,
        );
        prepared.push(request.message.body);
        return {
          requestGenerationId: `record-${prepared.length}`,
          generationOrdinal: 1,
          sessionId: options.hostSessionId,
        };
      },
    };

    const read = (messages, number) => {
      assert.equal(messages.at(-1)?.errorCode, undefined, messages.find((item) => item.type === 'error')?.error);
      assert.equal(messages.find((item) => item.type === 'text')?.content, `host-loopback-claude-reply-${number}`);
      return messages.at(-1)?.metadata.sessionId;
    };
    const first = await Array.fromAsync(
      service.invoke('CLAUDE_HOST_FIRST_FIXTURE', { ...options, invocationId: 'first' }),
    );
    const sessionId = read(first, 1);
    t.diagnostic(`First turn complete at ${Math.round(performance.now() - startedAt)} ms`);
    assert.match(sessionId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    const warm = await Array.fromAsync(
      service.invoke('CLAUDE_HOST_WARM_FIXTURE', {
        ...options,
        invocationId: 'warm',
        sessionId,
        requireExactResume: true,
      }),
    );
    assert.equal(read(warm, 2), sessionId);
    t.diagnostic(`Warm turn complete at ${Math.round(performance.now() - startedAt)} ms`);

    await service.releaseAll('reopen');
    const resumedOptions = { ...options, sessionId, requireExactResume: true };
    const resumed = await Array.fromAsync(
      service.invoke('CLAUDE_HOST_RESUMED_FIXTURE', {
        ...resumedOptions,
        invocationId: 'resume',
      }),
    );
    assert.equal(read(resumed, 3), sessionId);
    t.diagnostic(`Exact resume complete at ${Math.round(performance.now() - startedAt)} ms`);

    assert.deepEqual(prepared, [
      'CLAUDE_HOST_FIRST_FIXTURE',
      'CLAUDE_HOST_WARM_FIXTURE',
      'CLAUDE_HOST_RESUMED_FIXTURE',
    ]);
    assert.equal(handled.length, 3);
    for (const { body, apiKey: selectedKey } of handled) {
      assert.equal(selectedKey === apiKey, true);
      assert.match(JSON.stringify(body.system), /CLAUDE_HOST_IDENTITY_FIXTURE/);
      assert.doesNotMatch(JSON.stringify(body.messages), /CLAUDE_HOST_(UPDATED_)?IDENTITY_FIXTURE/);
    }
    assert.match(JSON.stringify(handled[2].body.messages), /CLAUDE_HOST_FIRST_FIXTURE/);
    assert.match(JSON.stringify(handled[2].body.messages), /host-loopback-claude-reply-2/);

    const wrongWorkspace = await Array.fromAsync(
      service.invoke('Do not change workspaces', {
        ...resumedOptions,
        invocationId: 'wrong-workspace',
        workingDirectory: join(root, 'other-workspace'),
        sessionId,
      }),
    );
    assert.ok(wrongWorkspace.at(-1)?.errorCode);
    const denied = await Array.fromAsync(
      service.invoke('Do not launch without a record', {
        ...resumedOptions,
        invocationId: 'record-denied',
        sessionId,
        async beforeProviderLaunch() {
          throw new Error('isolated record denied');
        },
      }),
    );
    assert.ok(denied.at(-1)?.errorCode);

    const changed = { ...resumedOptions, systemPrompt: updatedIdentity };
    const staleRole = await Array.fromAsync(
      service.invoke('Do not reuse the previous identity', { ...changed, invocationId: 'strict-role-change' }),
    );
    assert.equal(staleRole.at(-1)?.errorCode, 'resume_unavailable');
    assert.equal(handled.length, 3);
    const fresh = await Array.fromAsync(
      service.invoke('CLAUDE_HOST_NEW_ROLE_FIXTURE', {
        ...changed,
        invocationId: 'role-change',
        requireExactResume: false,
      }),
    );
    const newSessionId = read(fresh, 4);
    assert.notEqual(newSessionId, sessionId);
    const notice = fresh.find(
      (event) => event.type === 'system_info' && event.content?.includes('session_resume_fresh_start'),
    );
    assert.equal(JSON.parse(notice?.content ?? '{}').previousSessionId, sessionId);
    assert.match(JSON.stringify(handled[3].body.system), /CLAUDE_HOST_UPDATED_IDENTITY_FIXTURE/);
    assert.doesNotMatch(
      JSON.stringify(handled[3].body.messages),
      /CLAUDE_HOST_FIRST_FIXTURE|CLAUDE_HOST_UPDATED_IDENTITY_FIXTURE/,
    );

    await service.releaseAll('return-to-original-role');
    const originalHistory = await Array.fromAsync(
      service.invoke('CLAUDE_HOST_ORIGINAL_ROLE_FIXTURE', { ...resumedOptions, invocationId: 'reopen-original' }),
    );
    assert.equal(read(originalHistory, 5), sessionId);
    assert.match(JSON.stringify(handled[4].body.messages), /CLAUDE_HOST_FIRST_FIXTURE/);
    assert.doesNotMatch(JSON.stringify(handled[4].body.messages), /CLAUDE_HOST_NEW_ROLE_FIXTURE/);
    t.diagnostic(
      `Role update and original-history readback complete at ${Math.round(performance.now() - startedAt)} ms`,
    );

    writeCredential(accountRef, { apiKey: 'rotated-claude-key' }, root);
    const stale = await Array.fromAsync(
      service.invoke('Do not use a rotated credential', {
        ...resumedOptions,
        invocationId: 'stale',
        sessionId,
      }),
    );
    assert.ok(stale.at(-1)?.errorCode);
    assert.equal(handled.length, 5);
    t.diagnostic(
      `Trusted catalog archive used Claude Code ${detection.candidates[0].state.version} and retained the native session.`,
    );
  },
);

test('only a catalog Claude Code package can obtain a default native grant', () => {
  const detection = { ...ref, action: 'detect', activationSignal: new AbortController().signal };
  assert.equal(
    grantAgentAdapterNativeRuntime({ ...detection, packageProvenance: { kind: 'local-archive' } }),
    undefined,
  );
  assert.ok(
    grantAgentAdapterNativeRuntime({
      ...detection,
      packageProvenance: {
        kind: 'catalog',
        catalogId: 'agent-claude-code',
        packageName: '@clowder-ai/agent-claude-code',
      },
    })?.inspect,
  );
});
