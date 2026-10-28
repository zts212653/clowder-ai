import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_REQUEST_DIAGNOSTIC_HEADER, catRegistry, routingContextReadModelV1Schema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { toAllCatConfigs } from '../../../api/src/config/cat-config-loader.ts';
import { configEventBus } from '../../../api/src/config/config-event-bus.ts';
import { readRuntimeCatCatalog } from '../../../api/src/config/runtime-cat-catalog.ts';
import { invokeSingleCat } from '../../../api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts';
import { emitLifecycleMessageUpdated } from '../../../api/src/domains/cats/services/agents/invocation/lifecycle-message-update.ts';
import { accountsRoutes } from '../../../api/src/routes/accounts.ts';
import { catsRoutes } from '../../../api/src/routes/cats.ts';
import { configRoutes } from '../../../api/src/routes/config.ts';
import { servicesRoutes } from '../../../api/src/routes/services.ts';
import { createCodexStartupRouteHarness } from '../../../api/test/helpers/codex-startup-route-harness.mjs';
import {
  createReviewState,
  findFreePort,
  fixtureForApi,
  NEXT_BIN,
  stopServer,
  THREAD_ID,
  WEB_ROOT,
  waitForPage,
} from './f309-ordinary-workspace-journey-fixture.mjs';
import { createFixtureLoginDriver } from './f320-native-login.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

export async function startFinalAccountPreview({
  withOverrides = false,
  withClaude = false,
  routingSnapshot,
  withServicePreview = false,
  withStartupRecovery = false,
  ownerUserId,
} = {}) {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'f320-browser-api-'));
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
    CAT_CAFE_RUNTIME_ROOT: withStartupRecovery ? join(root, 'disposable-runtime') : root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
    CAT_CAFE_PROJECT_ALLOWED_ROOTS: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    AUDIT_LOG_DIR: join(root, 'audit'),
  });
  if (ownerUserId !== undefined) process.env.DEFAULT_OWNER_USER_ID = ownerUserId;
  if (withStartupRecovery) mkdirSync(join(root, 'disposable-runtime'));
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  mkdirSync(join(root, '.cat-cafe'));
  if (withStartupRecovery)
    writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
  writeFileSync(
    join(root, '.cat-cafe', 'accounts.json'),
    JSON.stringify({
      codex: { authType: 'oauth', clientId: 'openai', displayName: '默认 Codex' },
      ...(withOverrides
        ? {
            exception: {
              authType: 'api_key',
              clientId: 'openai',
              displayName: '例外公司号',
              baseUrl: 'https://fixture.test/v1',
              models: ['fixture'],
            },
          }
        : {}),
    }),
  );
  if (withOverrides)
    writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ exception: { apiKey: 'fixture-only' } }));
  const variant = (id) => ({
    id: `${id}-default`,
    catId: id,
    carrier: 'cli',
    clientId: 'openai',
    defaultModel: 'fixture',
    mcpSupport: true,
    accountRef: 'codex',
    mentionPatterns: [`@${id}`],
    cli: { command: 'codex', outputFormat: 'json' },
  });
  writeFileSync(
    join(root, '.cat-cafe', 'cat-catalog.json'),
    JSON.stringify({
      version: 2,
      ...(withOverrides ? { selectedAccountRefs: { openai: 'codex' } } : {}),
      breeds: [
        ...(withClaude
          ? [
              {
                id: 'ragdoll',
                catId: 'opus',
                name: '布偶猫',
                displayName: '布偶猫',
                avatar: '/avatars/opus.png',
                color: { primary: '#123456', secondary: '#abcdef' },
                mentionPatterns: ['@opus'],
                roleDescription: 'fixture',
                defaultVariantId: 'opus-default',
                variants: ['opus', 'sonnet'].map((id) => ({
                  ...variant(id),
                  clientId: 'anthropic',
                  defaultModel: 'claude-sonnet-4-6',
                  accountRef: 'claude',
                  cli: { command: 'claude', outputFormat: 'stream-json' },
                })),
              },
            ]
          : []),
        {
          id: 'maine',
          catId: 'codex61-sol',
          name: '缅因猫',
          displayName: '缅因猫',
          avatar: '/avatars/codex.png',
          color: { primary: '#123456', secondary: '#abcdef' },
          mentionPatterns: ['@codex61-sol'],
          roleDescription: 'fixture',
          defaultVariantId: 'codex61-sol-default',
          variants: [
            variant('codex61-sol'),
            {
              ...variant('codex-sol'),
              ...(withOverrides ? { accountRef: 'exception', accountBindingMode: 'override' } : {}),
            },
          ],
        },
      ],
      roster: {
        ...(withClaude
          ? Object.fromEntries(
              ['opus', 'sonnet'].map((id) => [
                id,
                { family: 'ragdoll', roles: ['assistant'], lead: false, available: true, evaluation: 'fixture' },
              ]),
            )
          : {}),
        'codex61-sol': { family: 'maine', roles: ['assistant'], lead: false, available: true, evaluation: 'fixture' },
        'codex-sol': { family: 'maine', roles: ['assistant'], lead: false, available: true, evaluation: 'fixture' },
      },
      reviewPolicy: {
        requireDifferentFamily: false,
        preferActiveInThread: false,
        preferLead: false,
        excludeUnavailable: true,
      },
      coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
    }),
  );
  writeFileSync(join(root, 'cat-template.json'), readFileSync(join(root, '.cat-cafe', 'cat-catalog.json')));
  const previousRegistry = catRegistry.getAllConfigs();
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(readRuntimeCatCatalog(root))))
    catRegistry.register(id, config);
  const messages = [];
  let invocationNumber = 0;
  let quotaMode = 'body';
  const nativeLogin = createFixtureLoginDriver();
  const app = Fastify();
  const startup = withStartupRecovery
    ? createCodexStartupRouteHarness({
        root,
        threadId: THREAD_ID,
        catId: 'codex61-sol',
        retryDelaysMs: [2_000, 5_000, 1_000, 1_000, 1_000],
        onEvent: (event) => sockets.emit('agent_message', { ...event, threadId: THREAD_ID }),
        onResponse: (response) =>
          emitLifecycleMessageUpdated(
            { emitToUser: (_user, event, data) => sockets.emit(event, data) },
            'fixture',
            response,
          ),
      })
    : undefined;
  const fallback = createReviewState();
  app.addHook('onRequest', async (request, reply) => {
    request.headers['x-cat-cafe-user'] = 'fixture';
    if (withServicePreview || withStartupRecovery) request.sessionUserId = 'fixture';
    const origin = request.headers.origin;
    if (origin && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
      reply
        .header('access-control-allow-origin', origin)
        .header('access-control-allow-credentials', 'true')
        .header('access-control-allow-headers', `content-type,x-csrf-token,${CLIENT_REQUEST_DIAGNOSTIC_HEADER}`)
        .header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  app.options('/*', async () => ({}));
  app.post('/api/session', async () => ({ userId: 'fixture', csrfToken: 'fixture' }));
  app.post('/api/auth/session', async () => ({ userId: 'fixture', csrfToken: 'fixture' }));
  await app.register(accountsRoutes, {
    loginDriver: nativeLogin.driver,
    quotaFetcher: async () =>
      quotaMode === 'body'
        ? Response.json({
            credits_balance: 20,
            rate_limit: {
              primary_window: {
                used_percent: 30,
                limit_window_seconds: 18000,
                reset_at: 1893553445,
              },
            },
          })
        : Response.json(
            {},
            {
              headers: {
                'x-codex-primary-used-percent': '40',
                'x-codex-primary-reset-at': '1893553445',
                'x-codex-credits-balance': '20',
              },
            },
          ),
  });
  await app.register(catsRoutes);
  await app.register(configRoutes, { projectRoot: root });
  app.get('/api/messages', async () => ({
    messages: [...messages, ...(startup?.store.getByThread(THREAD_ID) ?? [])],
    hasMore: false,
  }));
  if (startup) {
    app.post('/api/fixture/startup', async (request) => {
      const body = request.body ?? {};
      if (!['recover', 'fail'].includes(body.scenario) || !['user', 'system_wake'].includes(body.origin))
        throw new Error('invalid startup fixture');
      const run = startup.start(body);
      void run.pending.catch((error) => {
        run.error = String(error);
      });
      return { runId: startup.runs.length - 1, sourceId: run.source.id };
    });
    app.get('/api/fixture/startup/:id', async (request) => {
      const run = startup.runs[Number(request.params.id)];
      return {
        response: startup.store.getById(run?.responseId),
        wireCount: run?.wires.length,
        turnStarts: run?.wires.flatMap((w) => w.writes).filter((m) => m.method === 'turn/start').length,
        error: run?.error,
        errors: run?.events.filter((event) => event.type === 'error'),
      };
    });
    app.post('/api/fixture/startup/:id/stop', async (request) => {
      startup.runs[Number(request.params.id)]?.controller.abort('user_cancel');
      return { stopped: true };
    });
  }
  app.get('/*', async (request) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/session' || url.pathname === '/api/auth/session')
      return { userId: 'fixture', csrfToken: 'fixture' };
    if (url.pathname === '/api/debug/callback-auth')
      return {
        reasonCounts: {},
        toolCounts: {},
        byCat: {},
        recentSamples: [],
        totalFailures: 0,
        startedAt: 0,
        uptimeMs: 0,
        recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
      };
    if (url.pathname === '/api/agent-hooks/status') return { status: 'configured', targets: [] };
    if (url.pathname === '/api/routing-context/snapshot') {
      if (routingSnapshot) return routingContextReadModelV1Schema.parse(routingSnapshot());
      const common = { v: 1, ownerId: 'fixture', observedAt: Date.now(), catalogRevision: 'fixture:f320' };
      return routingContextReadModelV1Schema.parse({
        ...common,
        signalEvents: [],
        preferenceRevisions: [],
        resolution: {
          state: 'fresh',
          inputRevisionRef: 'fixture:f320-routing',
          sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
          snapshot: { ...common, candidates: [] },
        },
      });
    }
    if (url.pathname === '/api/config/default-cat') return { catId: 'codex61-sol' };
    if (url.pathname === '/api/config/cat-order') return { catOrder: ['codex61-sol', 'codex-sol'] };
    return fixtureForApi(url, undefined, fallback);
  });
  if (withServicePreview)
    await app.register(servicesRoutes, {
      env: { CAT_CAFE_PROFILE: 'test' },
      fetchHealth: async () => ({ ok: true, status: 200, error: null }),
      lifecycle: {
        serviceConfig: {
          get: () => ({
            installed: true,
            enabled: false,
            selectedModel: 'mlx-community/Qwen3-ASR-1.7B-8bit',
            port: 19876,
          }),
        },
        findPidsByPort: async () => [],
      },
    });
  const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
  const { Server } = requireApi('socket.io');
  const sockets = new Server(app.server, { cors: { origin: true, credentials: true } });
  const unsubscribe = configEventBus.onConfigChange((event) => {
    if (event.source === 'cat-config') sockets.emit('cat-config-changed', event);
  });
  sockets.on('connection', (socket) =>
    socket.onAny((_event, ...args) => {
      const acknowledge = args.at(-1);
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    }),
  );
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const environment = await createNextDevTestEnvironment('f320-final', {
    NEXT_PUBLIC_API_URL: apiUrl,
    API_SERVER_PORT: new URL(apiUrl).port,
  });
  const sync = spawnSync(process.execPath, [join(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  if (sync.status !== 0) throw new Error(sync.stderr);
  const port = await findFreePort();
  const output = [];
  const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: environment.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (data) => output.push(String(data)));
  server.stderr.on('data', (data) => output.push(String(data)));
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    await stopServer(server);
    unsubscribe();
    nativeLogin.close();
    await app.close();
    sockets.close();
    await environment.cleanup();
    catRegistry.reset();
    for (const [id, config] of Object.entries(previousRegistry)) catRegistry.register(id, config);
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await waitForPage(url, server, output);
  } catch (error) {
    await close();
    throw error;
  }
  function assertSelectedToken(options) {
    if (options.claudeTokenAccount && !options.accountEnv?.CLAUDE_CODE_OAUTH_TOKEN?.startsWith('sk-ant-oat01-fixture-'))
      throw new Error('fixture Claude token not selected');
  }
  return {
    url,
    apiUrl,
    root,
    startup,
    threadId: THREAD_ID,
    output,
    close,
    setQuota(mode) {
      quotaMode = mode;
    },
    async reply(content, catId = 'codex61-sol', waitBeforeDone, onStarted) {
      // Transport is deterministic; all account selection and execution metadata come from
      // the real invocation producer and the same registry that binding updates.
      const deps = {
        registry: {
          create: async () => ({ invocationId: `fixture-${++invocationNumber}`, callbackToken: 'fixture' }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          store: async () => {},
          delete: async () => {},
          resolveWorkingDirectory: () => root,
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:0',
      };
      const service = {
        async *invoke(_prompt, options) {
          if (catId === 'opus') assertSelectedToken(options);
          onStarted?.();
          yield {
            type: 'metadata',
            catId,
            timestamp: Date.now(),
            metadata: {
              model: 'fixture',
              provider: catId === 'opus' ? 'anthropic' : 'openai',
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
          yield { type: 'text', catId, timestamp: Date.now(), content };
          if (waitBeforeDone) await waitBeforeDone;
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      };
      const events = [];
      for await (const event of invokeSingleCat(deps, {
        catId,
        service,
        prompt: content,
        userId: 'fixture',
        threadId: THREAD_ID,
        isLastCat: true,
      }))
        events.push(event);
      const metadata = events.find((event) => event.type === 'metadata')?.metadata;
      if (!metadata?.executionAccount || events.some((e) => e.type === 'error'))
        throw new Error(
          `fixture invocation failed: ${JSON.stringify({ hasMetadata: !!metadata, hasAccountSnapshot: !!metadata?.executionAccount, errors: events.filter((e) => e.type === 'error').map((e) => ({ error: e.error, code: e.errorCode })) })}`,
        );
      messages.push({
        from: { kind: 'agent', catId: catId },
        id: `reply-${messages.length}`,
        threadId: THREAD_ID,
        type: 'assistant',
        catId,
        content,
        timestamp: Date.now(),
        metadata,
      });
      return metadata.executionAccount;
    },
    captureLoginAttempt: nativeLogin.captureLoginAttempt,
  };
}
