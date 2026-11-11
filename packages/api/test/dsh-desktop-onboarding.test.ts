import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { stringify } from 'yaml';
import { registerDshSetupRoutes } from '../src/routes/dsh-setup-route.js';

(['stored', 'project', 'home', 'record', 'official', 'missing', 'invalid'] as const).forEach((authentication) =>
  test(
    authentication === 'official'
      ? 'Desktop prefers official credentials in its native store without an environment key'
      : authentication === 'missing'
        ? 'Desktop refuses a missing explicit custom reference without borrowing another key'
        : authentication === 'invalid'
          ? 'Desktop distinguishes an unreadable credential document from missing authentication'
          : `Desktop onboarding uses ${authentication} custom authentication without an official key across a cold restart`,
    { skip: !process.env.DSH_DESKTOP_TEST_COMMAND, timeout: 180_000 },
    async (t) => {
      const command = process.env.DSH_DESKTOP_TEST_COMMAND!;
      const root = mkdtempSync(join(tmpdir(), 'desktop-onboarding-'));
      const home = join(root, 'native');
      const cwd = join(root, 'host');
      const desktop = join(home, 'profiles/desktop');
      mkdirSync(desktop, { recursive: true });
      mkdirSync(join(home, 'profiles/acp'), { recursive: true });
      mkdirSync(cwd);
      const previous = Object.fromEntries(
        [
          'CAT_CAFE_CONFIG_ROOT',
          'CAT_CAFE_GLOBAL_CONFIG_ROOT',
          'CAT_TEMPLATE_PATH',
          'DEEPSEEK_API_KEY',
          'ISSUE1925_CUSTOM_KEY',
        ].map((key) => [key, process.env[key]]),
      );
      process.env.CAT_CAFE_CONFIG_ROOT = cwd;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = cwd;
      const template = JSON.parse(
        readFileSync(fileURLToPath(new URL('../../../cat-template.json', import.meta.url)), 'utf8'),
      );
      process.env.CAT_TEMPLATE_PATH = join(cwd, 'cat-template.json');
      writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify(template));
      mkdirSync(join(cwd, '.cat-cafe'));
      writeFileSync(join(cwd, '.cat-cafe/cat-catalog.json'), JSON.stringify({ ...template, breeds: [] }));
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.ISSUE1925_CUSTOM_KEY;
      t.after(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        });
        rmSync(root, { recursive: true, force: true });
      });
      let officialRequests = 0;
      const customRequests: { model: string; auth: string | undefined }[] = [];
      const server = createServer(async (request, response) => {
        if (request.url?.startsWith('/official')) {
          officialRequests += 1;
          response.writeHead(500).end();
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const data = JSON.parse(body) as { model: string };
        customRequests.push({ model: data.model, auth: request.headers.authorization });
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'DSH_CONNECTION_OK' }, finish_reason: null }],
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
      await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
      t.after(() => new Promise<void>((accept) => server.close(() => accept())));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const files = {
        [join(desktop, 'package.json')]: JSON.stringify({
          private: true,
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
        }),
        [join(desktop, 'cordis.patch.yml')]: stringify([
          { id: 'llm-deepseek', config: { baseURL: `${origin}/official` } },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                custom: {
                  api: 'openai-completions',
                  baseURL: `${origin}/custom/v1`,
                  ...(authentication === 'record' ? {} : { apiKeyEnv: 'ISSUE1925_CUSTOM_KEY' }),
                  models: [
                    { id: 'only-custom-model', contextWindow: 131072, maxTokens: 1024 },
                    { id: 'other-model', contextWindow: 131072, maxTokens: 1024 },
                  ],
                },
              },
            },
          },
        ]),
        [join(home, 'profiles/acp/cordis.patch.yml')]: '# old ACP is invalid\n',
        // The provider's ordinary startup would migrate this flat file. Onboarding must not.
        [join(home, '.credentials.yaml')]:
          authentication === 'official'
            ? 'DEEPSEEK_API_KEY: fixture-official-key\nISSUE1925_CUSTOM_KEY: fixture-custom-key\n'
            : authentication === 'missing'
              ? 'OTHER_API_KEY: fixture-other-key\n'
              : authentication === 'invalid'
                ? 'version: 1\nrefs: [invalid]\n'
                : authentication === 'stored'
                  ? 'ISSUE1925_CUSTOM_KEY: fixture-custom-key\n'
                  : authentication === 'record'
                    ? 'version: 1\nrecords:\n  llm-pi-ai/custom:\n    kind: api-key\n    key: fixture-custom-key\n'
                    : '',
        ...(authentication === 'home' || authentication === 'project'
          ? { [join(authentication === 'home' ? home : desktop, '.env')]: 'ISSUE1925_CUSTOM_KEY=fixture-custom-key\n' }
          : {}),
      };
      Object.entries(files).forEach(([path, text]) => writeFileSync(path, text, { mode: 0o600 }));
      const app = Fastify();
      app.decorateRequest('sessionUserId', 'fixture-owner');
      registerDshSetupRoutes(app, {
        resolveDesktopLaunch: () => ({ command, cwd, nativeHome: home, nativeCwd: desktop }),
        audit: async () => {},
      });
      t.after(() => app.close());
      const inspection = await app.inject({
        method: 'POST',
        url: '/api/cats/dsh-setup/inspect',
        payload: { runtimeId: 'dsh' },
      });
      if (authentication === 'invalid') {
        assert.equal(inspection.statusCode, 422);
        assert.equal(inspection.json().error, 'dsh_setup_credential_invalid');
        assert.equal(officialRequests, 0);
        assert.equal(customRequests.length, 0);
        Object.entries(files).forEach(([path, bytes]) => assert.equal(readFileSync(path, 'utf8'), bytes));
        return;
      }
      assert.equal(inspection.statusCode, 200, inspection.body);
      const view = inspection.json();
      if (authentication === 'official' || authentication === 'missing') {
        assert.equal(view.provider, authentication === 'official' ? 'deepseek-official' : undefined);
        if (authentication === 'missing') {
          const rejected = await app.inject({
            method: 'POST',
            url: '/api/cats/dsh-setup/prepare',
            payload: { runtimeId: 'dsh', revision: view.revision, provider: 'custom', model: 'only-custom-model' },
          });
          assert.equal(rejected.statusCode, 422);
          assert.equal(rejected.json().error, 'dsh_setup_credential_missing');
        }
        assert.equal(officialRequests, 0);
        assert.equal(customRequests.length, 0);
        Object.entries(files).forEach(([path, bytes]) => assert.equal(readFileSync(path, 'utf8'), bytes));
        return;
      }
      assert.equal(view.provider, 'custom');
      assert.equal(view.model, 'only-custom-model');
      assert.equal(view.profiles, undefined, 'profile selection is internal');
      assert.equal(officialRequests, 0);
      assert.equal(customRequests.length, 0, 'inspection never sends a prompt');
      const preparedResponse = await app.inject({
        method: 'POST',
        url: '/api/cats/dsh-setup/prepare',
        payload: { runtimeId: 'dsh', revision: view.revision, provider: view.provider, model: view.model },
      });
      assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
      const prepared = preparedResponse.json();
      assert.ok(prepared.env.DSH_HOME);
      assert.notEqual(prepared.env.DSH_HOME, home);
      assert.equal(JSON.stringify(prepared).includes('fixture-custom-key'), false, 'no secret enters the member draft');
      const verified = await app.inject({
        method: 'POST',
        url: '/api/cats/dsh-setup/test',
        payload: { id: prepared.id, model: JSON.stringify(['custom', 'only-custom-model']) },
      });
      assert.equal(verified.statusCode, 200, verified.body);
      // Use the real member API and persisted catalog; restart the production service/pool.
      const { catsRoutes } = await import('../src/routes/cats.js');
      const { getResolvedCats } = await import('../src/config/resolved-cats.js');
      const { getRegisteredAcpConfig, _resetCachedConfig } = await import('../src/config/cat-config-loader.js');
      const { createAcpServiceForConfig } = await import(
        '../src/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
      );
      const members = Fastify();
      await members.register(catsRoutes);
      t.after(() => members.close());
      const created = await members.inject({
        method: 'POST',
        url: '/api/cats',
        headers: { 'x-cat-cafe-user': 'fixture-owner' },
        payload: {
          catId: `desktop-${authentication}`,
          name: 'Desktop fixture',
          displayName: 'Desktop fixture',
          clientId: 'acp',
          carrier: 'acp',
          configurationSource: 'native_tool',
          defaultModel: JSON.stringify(['custom', 'only-custom-model']),
          mentionPatterns: [`@desktop-${authentication}`],
          roleDescription: 'Isolated acceptance fixture',
          color: { primary: '#123456', secondary: '#abcdef' },
          mcpSupport: false,
          acp: { command: prepared.command, startupArgs: prepared.startupArgs, transport: 'stdio' },
          env: prepared.env,
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const saved = created.json().cat;
      assert.deepEqual(saved.env, prepared.env);
      const catalog = await members.inject({
        method: 'POST',
        url: '/api/cats/runtime-models',
        headers: { 'x-cat-cafe-user': 'fixture-owner' },
        payload: { runtimeId: `acp:${saved.id}`, catId: saved.id },
      });
      assert.equal(catalog.statusCode, 200, catalog.body);
      assert.equal(catalog.json().defaultModel, JSON.stringify(['custom', 'only-custom-model']), catalog.body);
      assert.equal(customRequests.length, 1, 'catalog discovery sends no model prompt');
      let sessionId: string | undefined;
      for (let restart = 0; restart < 2; restart += 1) {
        if (restart === 1) {
          const oldPatch = readFileSync(prepared.startupArgs.at(-1), 'utf8');
          const marker = join(prepared.env.DSH_HOME, 'session-preservation-marker');
          writeFileSync(marker, sessionId!);
          const updated = await app.inject({
            method: 'POST',
            url: '/api/cats/dsh-setup/prepare',
            payload: {
              runtimeId: 'dsh',
              memberId: saved.id,
              revision: view.revision,
              provider: 'custom',
              model: 'other-model',
            },
          });
          assert.equal(updated.statusCode, 200, updated.body);
          const binding = updated.json();
          assert.equal(
            binding.env.DSH_HOME,
            prepared.env.DSH_HOME,
            'model changes retain the member HOME and ACP sessions',
          );
          assert.notDeepEqual(binding.startupArgs, prepared.startupArgs, 'new route uses a new immutable patch');
          assert.equal(readFileSync(prepared.startupArgs.at(-1), 'utf8'), oldPatch);
          assert.equal(readFileSync(marker, 'utf8'), sessionId);
          const patched = await members.inject({
            method: 'PATCH',
            url: `/api/cats/${saved.id}`,
            headers: { 'x-cat-cafe-user': 'fixture-owner' },
            payload: {
              expectedRevision: saved.configurationRevision,
              defaultModel: '["custom","other-model"]',
              acp: { command: binding.command, startupArgs: binding.startupArgs, transport: 'stdio' },
              env: binding.env,
            },
          });
          assert.equal(patched.statusCode, 200, patched.body);
        }
        _resetCachedConfig();
        const config = getResolvedCats(cwd)[saved.id];
        assert.ok(config);
        assert.deepEqual(config.env, prepared.env);
        assert.equal(
          config.defaultModel,
          JSON.stringify(['custom', restart === 0 ? 'only-custom-model' : 'other-model']),
        );
        const acpConfig = getRegisteredAcpConfig(saved.id, cwd);
        assert.ok(acpConfig);
        const service = await createAcpServiceForConfig({
          projectRoot: cwd,
          profileId: saved.id,
          config,
          effectiveModel: config.defaultModel,
          acpConfig,
          poolRegistry: new Map(),
          log: members.log,
        });
        assert.ok(service);
        try {
          for (const prompt of restart === 0
            ? ['Reply DSH_CONNECTION_OK without tools.', 'Repeat that exact marker without tools.']
            : ['Reply DSH_CONNECTION_OK again.']) {
            const events = [];
            const previousSession = sessionId;
            for await (const event of service.invoke(prompt, sessionId ? { sessionId } : undefined)) events.push(event);
            assert.equal(
              events.some((event) => event.type === 'error'),
              false,
              JSON.stringify(events),
            );
            assert.ok(JSON.stringify(events).includes('DSH_CONNECTION_OK'));
            const initializedSession = events.find((event) => event.type === 'session_init')?.sessionId;
            if (restart === 1)
              assert.equal(initializedSession, previousSession, 'the model edit resumes the same ACP session');
            sessionId = initializedSession ?? sessionId;
          }
        } finally {
          await service.disposeHostService();
        }
      }
      assert.equal(officialRequests, 0, 'no official /models or inference request');
      assert.equal(customRequests.length, 4);
      customRequests.forEach((request, index) => {
        assert.equal(request.model, index === 3 ? 'other-model' : 'only-custom-model');
        assert.equal(request.auth, 'Bearer fixture-custom-key');
      });
      Object.entries(files).forEach(([path, bytes]) => assert.equal(readFileSync(path, 'utf8'), bytes));
    },
  ),
);
