import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { stringify } from 'yaml';
import { AcpClient } from '../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { dshSetupBootstrap, resolveDshSetupLaunch } from '../src/routes/dsh-setup-launch.js';
import { registerDshSetupRoutes } from '../src/routes/dsh-setup-route.js';
import { prepareDshSetup, readDshSetup } from '../src/routes/dsh-setup-service.js';

// Opt-in: a real preinstalled DSH package, local fake OpenAI endpoint, no vendor key or external request.
test(
  'native DSH: official default -> custom-only overlay -> text and same-session continuation',
  { skip: !process.env.DSH_SETUP_TEST_ENTRY, timeout: 180_000 },
  async (t) => {
    const entry = process.env.DSH_SETUP_TEST_ENTRY;
    assert.ok(entry);
    const root = mkdtempSync(join(tmpdir(), 'dsh-setup-native-'));
    const home = join(root, 'native-home'),
      host = join(root, 'host');
    mkdirSync(host);
    const before = {
      DSH_HOME: process.env.DSH_HOME,
      CAT_CAFE_CONFIG_ROOT: process.env.CAT_CAFE_CONFIG_ROOT,
      DSH_SETUP_FIXTURE_KEY: process.env.DSH_SETUP_FIXTURE_KEY,
    };
    process.env.DSH_HOME = home;
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.DSH_SETUP_FIXTURE_KEY = 'local-fixture-only';
    t.after(() => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(req.url, '/v1/chat/completions');
      const data = JSON.parse(body) as { model: string; messages: unknown[] };
      assert.equal(data.model, 'only-custom-model');
      requests.push(body);
      const answer = body.includes('REMEMBER_NATIVE_1668') ? 'NATIVE_1668_OK' : 'DSH_CONNECTION_OK';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: data.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const [profile, bundles] of Object.entries({
      desktop: ['@deepseek-ai/dsh-base'],
    })) {
      const directory = join(home, 'profiles', profile);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: `fixture-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles } } }),
      );
      writeFileSync(join(directory, 'cordis.yml'), '[]\n');
      writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n');
    }
    const desktopPatch = join(home, 'profiles/desktop/cordis.patch.yml');
    const nativeSource = stringify([
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            'custom-only': {
              api: 'openai-completions',
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKeyEnv: 'DSH_SETUP_FIXTURE_KEY',
              models: [{ id: 'only-custom-model', contextWindow: 131072, maxTokens: 1024 }],
            },
          },
        },
      },
    ]);
    writeFileSync(desktopPatch, nativeSource);
    const launch = resolveDshSetupLaunch(process.execPath, [entry, '--profile', 'acp'], host);
    const inspection = await readDshSetup(launch, 'desktop');
    assert.equal(inspection.view.active.provider, 'deepseek-official');
    assert.equal(requests.length, 0, 'inspection must not call any provider');
    await assert.rejects(prepareDshSetup(launch, 'desktop', 'changed', 'custom-only', 'only-custom-model'), /changed/);
    const app = Fastify();
    const audit: string[] = [];
    app.decorateRequest('sessionUserId', 'fixture-owner');
    registerDshSetupRoutes(app, {
      resolveLaunch: (id) => {
        assert.equal(id, 'dsh');
        return launch;
      },
      audit: async (target) => {
        audit.push(target);
      },
    });
    t.after(() => app.close());
    const preparedResponse = await app.inject({
      method: 'POST',
      url: '/api/cats/dsh-setup/prepare',
      payload: {
        runtimeId: 'dsh',
        sourceProfile: 'desktop',
        revision: inspection.view.revision,
        provider: 'custom-only',
        model: 'only-custom-model',
      },
    });
    assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
    const prepared = preparedResponse.json() as { id: string; startupArgs: string[] };
    assert.equal(requests.length, 0, 'preparation must not call any provider');
    assert.equal(readFileSync(desktopPatch, 'utf8'), nativeSource);
    assert.equal(
      existsSync(join(home, 'profiles/acp')),
      false,
      'reading/preparing must not initialize the native ACP profile',
    );
    assert.equal(readFileSync(join(home, 'profiles/desktop/cordis.yml'), 'utf8'), '[]\n');
    const verified = await app.inject({
      method: 'POST',
      url: '/api/cats/dsh-setup/test',
      payload: { id: prepared.id },
    });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.deepEqual(audit, ['dsh-acp-preparation', 'dsh-acp-connection-test']);
    const target = dshSetupBootstrap({ ...launch, args: prepared.startupArgs });
    const client = new AcpClient({
      command: target.command,
      args: target.args,
      cwd: target.verifyCwd(),
      permissionHandler: (_req, respond) => respond({ cancelled: true }),
    });
    try {
      await client.initialize();
      const session = await client.newSession(target.cwd, []);
      for (const prompt of [
        'Remember REMEMBER_NATIVE_1668; reply NATIVE_1668_OK without tools.',
        'Repeat the earlier marker reply without tools.',
      ]) {
        const result = await client.promptCollect(session.sessionId, prompt);
        assert.equal(result.stopReason, 'end_turn');
        assert.ok(JSON.stringify(result.events).includes('NATIVE_1668_OK'));
      }
      assert.equal(requests.length, 3);
      assert.ok(requests[2]?.includes('REMEMBER_NATIVE_1668'), 'native continuation contains the first turn');
    } finally {
      await client.close();
    }
    console.log(JSON.stringify({ nativeFixture: true, root, requests: requests.length, nativeFilesPreserved: true }));
  },
);
