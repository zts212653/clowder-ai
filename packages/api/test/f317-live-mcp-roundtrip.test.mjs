import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { CODEX_LIVE_POLICY_ARGS } from '../dist/domains/cats/services/agents/providers/codex-live-policy.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../dist/domains/concierge/live/LiveCompanionCall.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerNativeTurnAdmissionRoute } from '../dist/routes/callback-native-turn-admission.js';

function respond(res, call) {
  const events = [
    { type: 'response.created', response: { id: 'fixture', object: 'response', status: 'in_progress', output: [] } },
  ];
  if (call)
    events.push(
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      ...(call.type === 'custom_tool_call'
        ? [{ type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: call.id, delta: call.input }]
        : [
            {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              item_id: call.id,
              delta: call.arguments,
            },
            {
              type: 'response.function_call_arguments.done',
              output_index: 0,
              item_id: call.id,
              arguments: call.arguments,
            },
          ]),
      { type: 'response.output_item.done', output_index: 0, item: call },
    );
  events.push({
    type: 'response.completed',
    response: {
      id: 'fixture',
      object: 'response',
      status: 'completed',
      output: call ? [call] : [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

function requestedCall({ ordinal, codeMode, parsed, threadId, doc, privateDoc }) {
  const family = ordinal === 2 ? 'collab' : 'memory';
  const name = ordinal === 2 ? 'cat_cafe_get_thread_context' : 'cat_cafe_read_file_slice';
  const namespace = parsed.tools.find((tool) => tool.name === `mcp__cat_cafe_${family}`);
  if (!codeMode)
    assert.ok(
      namespace?.tools.some((tool) => tool.name === name),
      `role MCP missing ${name}`,
    );
  const args =
    ordinal === 2
      ? { threadId, responseMode: 'full' }
      : { path: ordinal === 3 ? privateDoc : doc, startLine: 1, endLine: 2 };
  const identity = { id: `fc_${ordinal}`, call_id: `call_${ordinal}` };
  return codeMode
    ? {
        ...identity,
        type: 'custom_tool_call',
        name: 'exec',
        namespace: 'functions',
        input: `text({shell:typeof tools.exec_command,patch:typeof tools.apply_patch,process:typeof process,require:typeof require});text(await tools.mcp__cat_cafe_${family}__${name}(${JSON.stringify(args)}));`,
      }
    : { ...identity, type: 'function_call', namespace: namespace.name, name, arguments: JSON.stringify(args) };
}

for (const codeMode of [false, true])
  test(
    `installed native ${codeMode ? 'code-mode executor' : 'direct tools'} uses Host role MCP and canonical revocation`,
    {
      skip: spawnSync('codex', ['--version']).status !== 0,
      timeout: 35_000,
    },
    async (t) => {
      // No real login, household database, screen or microphone. The provider and all data are local fixtures.
      const root = await mkdtemp(join(tmpdir(), 'f317-role-mcp-'));
      const docs = join(root, 'docs');
      const data = join(root, 'synthetic-data');
      await mkdir(docs);
      await mkdir(data);
      const doc = join(docs, 'synthetic.md');
      const privateDoc = join(data, 'ungranted.txt');
      await writeFile(privateDoc, 'UNGRANTED_SYNTHETIC_DATA');
      const canary = `SYNTHETIC_${randomUUID()}`;
      await writeFile(doc, `# Temporary fixture\n${canary}\n`);
      const principal = {
        invocationId: randomUUID(),
        callbackToken: randomUUID(),
        userId: 'fixture-owner',
        threadId: 'fixture-home',
        catId: 'codex-astra',
        createdAt: Date.now(),
        expiresAt: null,
      };
      let admitted = true;
      const verification = [];
      const callbacks = [];
      const api = Fastify();
      registerCallbackAuthHook(api, {
        verify: async (invocationId, callbackToken) => {
          verification.push({ invocationId, matches: callbackToken === principal.callbackToken, admitted });
          if (!admitted) return { ok: false, reason: 'unknown_invocation' };
          if (invocationId !== principal.invocationId || callbackToken !== principal.callbackToken)
            return { ok: false, reason: 'invalid_token' };
          return { ok: true, record: principal };
        },
      });
      registerNativeTurnAdmissionRoute(api);
      api.get('/api/callbacks/thread-context', async (request) => {
        callbacks.push({ principal: request.callbackAuth, query: request.query });
        return {
          threadId: principal.threadId,
          messages: [{ id: 'synthetic-reply', content: 'FIXTURE_COORDINATION_RETURN' }],
          hasMore: false,
        };
      });
      api.post('/api/callbacks/freshness-notice-check', async () => ({ notice: null }));
      const apiUrl = await api.listen({ port: 0, host: '127.0.0.1' });
      const requests = [];
      let fixtureError;
      const provider = http.createServer(async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(404);
            res.end();
            return;
          }
          let body = '';
          for await (const chunk of req) body += chunk;
          const parsed = JSON.parse(body);
          requests.push(parsed);
          const ordinal = requests.length;
          if (ordinal > 4) {
            respond(res);
            return;
          }
          if (ordinal === 4) admitted = false;
          respond(res, requestedCall({ ordinal, codeMode, parsed, threadId: principal.threadId, doc, privateDoc }));
        } catch (error) {
          fixtureError = error;
          respond(res);
        }
      });
      await new Promise((done) => provider.listen(0, '127.0.0.1', done));
      let call;
      let wire;
      try {
        call = await LiveCompanionCall.create({
          binding: {
            userId: principal.userId,
            threadId: principal.threadId,
            catId: principal.catId,
            callId: randomUUID(),
          },
          messageStore: new MessageStore(),
          mcpDistDir: fileURLToPath(new URL('../../mcp-server/dist', import.meta.url)),
          allowedDirectories: [docs],
          verifyNativeBinding: async (nativeId) => nativeId === nativeThreadId,
          publish() {},
        });
        let nativeThreadId;
        const config = await call.configure({
          CAT_CAFE_API_URL: apiUrl,
          CAT_CAFE_USER_ID: principal.userId,
          CAT_CAFE_THREAD_ID: principal.threadId,
          CAT_CAFE_CAT_ID: principal.catId,
          CAT_CAFE_INVOCATION_ID: principal.invocationId,
          CAT_CAFE_CALLBACK_TOKEN: principal.callbackToken,
        });
        const credentialFile = config.mcp_servers['cat-cafe-memory'].env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
        wire = await createDirectAgentCarrierSession({
          command: 'codex',
          cwd: root,
          invocationId: 'f317-role-mcp-fixture',
          args: [
            'app-server',
            ...CODEX_LIVE_POLICY_ARGS,
            ...(codeMode ? ['--enable', 'code_mode', '--enable', 'code_mode_only'] : []),
            '--config',
            'model_provider="fixture"',
            '--config',
            'model_providers.fixture.name="fixture"',
            '--config',
            `model_providers.fixture.base_url="http://127.0.0.1:${provider.address().port}/v1"`,
            '--config',
            'model_providers.fixture.wire_api="responses"',
            '--config',
            'model_providers.fixture.env_key="OPENAI_API_KEY"',
          ],
          env: {
            // DirectAgentCarrierSession merges overrides into its parent environment.
            ...Object.fromEntries(Object.keys(process.env).map((key) => [key, null])),
            PATH: process.env.PATH,
            HOME: root,
            CODEX_HOME: root,
            CAT_CAFE_DATA_DIR: join(root, 'synthetic-data'),
            OPENAI_API_KEY: 'synthetic-only',
            NO_PROXY: '127.0.0.1,localhost',
          },
        });
        const events = [];
        for await (const event of new CodexAppServerClient({ wire }).run({
          thread: { kind: 'start' },
          prompt: { kind: 'frozen', prompt: 'Read the temporary fixture using the selected tools.' },
          model: 'gpt-5',
          cwd: root,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          config,
          live: call,
          signal: AbortSignal.timeout(25_000),
        })) {
          events.push(event);
          if (event.type === 'thread.started') nativeThreadId = event.thread_id;
          if (event.type === 'app_server.live_turn_completed') await call.stop();
        }
        if (fixtureError) throw fixtureError;
        assert.equal(requests.length, 5, JSON.stringify(events.filter((event) => event.type === 'error')));
        const outputs = requests
          .at(-1)
          .input.filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
        if (codeMode) {
          for (const output of outputs) {
            assert.match(JSON.stringify(output), /shell.*undefined/);
            assert.match(JSON.stringify(output), /patch.*undefined/);
            assert.match(JSON.stringify(output), /process.*undefined/);
            assert.match(JSON.stringify(output), /require.*undefined/);
          }
        }
        assert.match(JSON.stringify(outputs.find((item) => item.call_id === 'call_1')), new RegExp(canary));
        assert.match(JSON.stringify(outputs.find((item) => item.call_id === 'call_2')), /FIXTURE_COORDINATION_RETURN/);
        assert.match(JSON.stringify(outputs.find((item) => item.call_id === 'call_3')), /Access denied/);
        assert.ok(!JSON.stringify(outputs).includes('UNGRANTED_SYNTHETIC_DATA'));
        assert.match(
          JSON.stringify(outputs.find((item) => item.call_id === 'call_4')),
          /Native tool admission is unavailable/,
        );
        assert.equal(callbacks.length, 1);
        assert.equal(callbacks[0].principal.invocationId, principal.invocationId);
        assert.equal(callbacks[0].query.responseMode, 'full');
        assert.ok(verification.every((entry) => entry.invocationId === principal.invocationId && entry.matches));
        assert.ok(verification.some((entry) => !entry.admitted));
        assert.equal(call.status().state, 'closed');
        await assert.rejects(readFile(credentialFile));
        t.diagnostic(
          'real native → production memory/collab MCP → canonical callback auth; synthetic file/context results and revocation verified',
        );
      } finally {
        await call?.stop();
        await wire?.close();
        provider.closeAllConnections();
        await new Promise((done) => provider.close(done));
        await api.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
