import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { resolveThreadAttentionPreferences } from '../../src/config/user-preferences-thread-attention.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createModuleHostInvocation } from '../../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import type { PluginRuntimeAdmission } from '../../src/domains/plugin/carrier/runtime-carrier.js';
import { DeclaredPluginUi } from '../../src/domains/plugin/declared/declared-plugin-ui.js';
import { DeclaredRuntimeContributions } from '../../src/domains/plugin/declared/declared-runtime-contributions.js';
import { createPluginThreadHost } from '../../src/domains/plugin/host-surface/plugin-thread-host.js';
import { resolveThreadAttentionGroups } from '../../src/domains/thread-navigation/thread-attention-group-metadata.js';
import { pluginUiRoutes } from '../../src/routes/plugin/plugin-ui-routes.js';
import { pluginWebhookForwardingRoutes } from '../../src/routes/plugin/plugin-webhook-forwarding-routes.js';
import { configuredFeedbackMember } from './feedback-member.mts';
import { feedbackStorageFixture } from './feedback-storage.mts';
import { buildPluginPanelBrowser } from './plugin-panel-browser.mts';

export async function startInstalledFeedbackFixture(credentialProvider?: 'github' | 'gitlab') {
  const archive = resolve(process.env.FEEDBACK_ARTIFACT ?? 'missing-feedback-artifact');
  const artifactRoot = resolve(
    process.env.FEEDBACK_JOURNEY_ARTIFACTS ?? '../../artifacts/feedback-installed',
    credentialProvider ?? '',
  );
  const consumer = join(
    artifactRoot,
    `consumer-${createHash('sha256')
      .update(await readFile(archive))
      .digest('hex')
      .slice(0, 12)}`,
  );
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, 'package.json'),
    '{"name":"isolated-feedback-consumer","private":true,"type":"module"}',
  );
  const npmCli = process.env.FEEDBACK_NPM_CLI;
  assert.ok(npmCli, 'FEEDBACK_NPM_CLI must identify the pinned npm CLI');
  execFileSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(artifactRoot, 'npm-cache'),
      archive,
    ],
    { cwd: consumer, stdio: 'pipe' },
  );
  const packageRoot = join(consumer, 'node_modules/@clowder-ai/feedback');
  const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
  assert.equal(validateManifest(manifest).valid, true);
  const module = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  const playwright = createRequire(import.meta.url)(process.env.FEEDBACK_PLAYWRIGHT_MODULE ?? 'playwright');
  const { script, css, cssSha256, cssSources } = await buildPluginPanelBrowser();

  let uploadedPng = Buffer.alloc(0);
  let failRead = false;
  let failUploadAt = 0;
  let uploadAttempt = 0;
  const github = credentialProvider === 'github';
  const remote = github ? 'https://github.example.test' : 'https://gitlab.example.test';
  const tokenKey = github ? 'githubToken' : 'gitlabToken';
  let secret = credentialProvider ? undefined : 'synthetic-token';
  let configurationRevision = 1;
  const targets = [
    {
      id: 'internal',
      label: '内部反馈',
      revision: 1,
      provider: github ? 'github' : 'gitlab',
      mode: 'both',
      project: 'team/clowder-ai',
      apiBaseUrl: github ? remote : `${remote}/api/v4`,
      issueCreateUrl: `${remote}/team/clowder-ai/${github ? 'issues/new' : '-/issues/new'}`,
      visibility: github ? 'public' : 'private',
      attachmentOrigins: [],
    },
  ];
  const persistence = feedbackStorageFixture();
  let posts = 0;
  const issues = new Map<string, { iid: number; web_url: string; title: string; description: string }>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    if (!address.startsWith(remote)) return originalFetch(url, init);
    if (credentialProvider) {
      const auth = new Headers(init?.headers).get(github ? 'authorization' : 'PRIVATE-TOKEN');
      if (auth !== (github ? 'Bearer synthetic-token' : 'synthetic-token')) return new Response(null, { status: 401 });
    }
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (address.endsWith('/user')) return json({ username: 'fixture-owner', login: 'fixture-owner' });
    if (address.endsWith('/uploads') && init?.method === 'POST') {
      uploadAttempt++;
      if (failUploadAt && uploadAttempt === failUploadAt) throw new Error('synthetic upload outage');
      assert.ok(init.body instanceof FormData);
      uploadedPng = Buffer.from(await (init.body.get('file') as File).arrayBuffer());
      assert.ok(!uploadedPng.includes(Buffer.from('private-metadata-canary')));
      return json({ full_path: '/team/clowder-ai/uploads/fixture/screenshot-1.png' });
    }
    if (address.includes('/uploads/fixture/')) return new Response(uploadedPng);
    if (address.endsWith('/issues') && init?.method === 'POST') {
      posts++;
      const data = JSON.parse(String(init.body));
      const issue = {
        iid: posts,
        web_url: `${remote}/team/clowder-ai/${github ? 'issues' : '-/issues'}/${posts}`,
        title: data.title,
        description: data.description ?? data.body,
      };
      issues.set(String(posts), issue);
      return json(issue);
    }
    const id = address.match(/\/issues\/(\d+)$/)?.[1];
    if (id) {
      if (failRead) {
        failRead = false;
        throw new Error('synthetic read outage');
      }
      return json(issues.get(id));
    }
    return json(
      github
        ? { full_name: 'team/clowder-ai', private: false, has_issues: true }
        : { path_with_namespace: 'team/clowder-ai', visibility: 'private', issues_enabled: true },
    );
  };
  const projectRoot = join(artifactRoot, 'diagnostic-project');
  const logDirectory = join(artifactRoot, 'diagnostic-logs');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  await writeFile(
    join(logDirectory, 'api.log'),
    JSON.stringify({ time: Date.now(), level: 50, msg: 'api_key=log-secret-canary E_TIMEOUT' }),
  );
  const threadStore = new ThreadStore();
  const threads = createPluginThreadHost({
    pluginId: manifest.pluginId,
    ownerUserId: 'fixture-owner',
    projectPath: projectRoot,
    threadStore,
    messageStore: { getByThread: async () => [], getByThreadBefore: async () => [] },
    threadDeepLinkUrl: (id) => `http://localhost/thread/${id}`,
    cats: {
      getAllCatIds: () => ['configured'],
      getRegisteredServices: () => new Map([['configured', {}]]),
      isCatAvailable: () => true,
      getCatAliases: () => [],
      getCatDisplayName: () => '已配置 Client',
    },
  });
  const memberFixture = configuredFeedbackMember((input) => activation.actions['feedback.delivery'](input));
  const host = {
    pluginInstanceId: 'fixture',
    dataPath: join(artifactRoot, 'retained-data'),
    config: { get: async () => JSON.stringify(targets) },
    secrets: { get: async (key: string) => (key === tokenKey ? secret : undefined) },
    storage: {
      ...persistence.storage,
      compareAndSet: async (key: string, expected: number | null, value: unknown) => {
        const result = await persistence.storage.compareAndSet(key, expected, value);
        await writeFile(join(artifactRoot, 'retained-journal.json'), JSON.stringify(await persistence.entries()));
        return result;
      },
    },
    runtimeInfo: {
      get: async () => ({
        version: 'synthetic',
        platform: 'win32',
        architecture: 'x64',
        nodeVersion: process.versions.node,
        projectRoot,
        logDirectory,
      }),
    },
    threads,
    members: memberFixture.members,
    messaging: memberFixture.messaging,
  };
  let activation = await module.default.create(manifest).start(host);
  const invocation = createModuleHostInvocation({ runtime: { actions: () => activation.actions } });
  const ui = new DeclaredPluginUi();
  const admission = {
    instance: { pluginInstanceId: 'fixture' },
    packageRecord: { pluginId: manifest.pluginId, manifest },
  } as unknown as PluginRuntimeAdmission;
  ui.activate(admission);
  const contributions = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await contributions.activate(admission, (id, method, input) => invocation.invoke(id, method, input));
  const app = Fastify();
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'fixture-owner';
  });
  app.get('/api/session', async () => ({ userId: 'fixture-owner', csrfToken: 'synthetic-csrf' }));
  await app.register(pluginUiRoutes, { ui });
  await app.register(pluginWebhookForwardingRoutes, { webhooks: contributions, ui });
  if (credentialProvider) {
    app.get('/api/plugin-manager/plugins/_local/official.feedback', async () => ({
      plugin: {
        pluginId: 'official.feedback',
        pluginInstanceId: 'fixture',
        artifact: 'installed',
        lifecycleRevision: configurationRevision,
        configFields: [{ key: tokenKey, kind: 'secret' }],
      },
    }));
    app.post<{
      Body: { expectedRevision: number; updates: { key: string; value: string }[] };
    }>('/api/plugin-manager/plugins/official.feedback/contributions/configuration', async (request, reply) => {
      const { expectedRevision, updates } = request.body;
      if (expectedRevision !== configurationRevision || updates.length !== 1 || updates[0]?.key !== tokenKey)
        return reply.status(409).send({ error: 'unexpected configuration' });
      ui.deactivate('fixture');
      await activation.stop({ reason: 'configuration_update' });
      secret = updates[0].value;
      configurationRevision++;
      activation = await module.default.create(manifest).start(host);
      ui.activate(admission);
      return { pluginId: 'official.feedback', pluginInstanceId: 'fixture' };
    });
  }
  app.get('/api/plugin-manager/plugins/:pluginId/icon', async (_, reply) =>
    reply.type('image/svg+xml').send(await readFile(join(packageRoot, 'assets/icon.svg'))),
  );
  app.get('/', async (_, reply) =>
    reply
      .type('text/html')
      .send(
        `<!doctype html><html data-theme="light" data-shell="v2"><style>${css}</style><body style="margin:0;background:#f8f7f5"><aside id="rail" style="position:fixed;inset:0 auto 0 0;width:56px;display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:20px"></aside><main id="workspace"></main><script>document.documentElement.setAttribute('data-cat-cafe-api-origin',location.origin);${script}</script></body></html>`,
      ),
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const ledger = {
    task: 'feedback-implementation',
    cssSha256,
    cssSources,
    owner: 'codex',
    purpose: 'packed plugin / actual Host UI bridge deterministic journey',
    pid: process.pid,
    url,
    sourceRoot: process.cwd(),
    archive,
    archiveSha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    dataRoot: host.dataPath,
    state: 'running',
    nativeHistory: 'not bound; no real model invocation',
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(artifactRoot, 'instance-ledger.json'), JSON.stringify(ledger, null, 2));

  return {
    artifactRoot,
    playwright,
    ledger,
    url,
    targets,
    issues,
    uploadedBytes: () => uploadedPng,
    failNextRead: () => {
      failRead = true;
    },
    failSecondUpload: () => {
      failUploadAt = uploadAttempt + 2;
    },
    journals: async () => Object.values(await persistence.entries()).map((v) => v.value),
    async analysisGroups() {
      const { aliases } = resolveThreadAttentionPreferences(projectRoot);
      const groups = await resolveThreadAttentionGroups(threadStore, 'fixture-owner');
      const titles = new Map(threadStore.list('fixture-owner').map(({ id, title }) => [id, title]));
      return groups.map((group) => ({
        ...group,
        name: aliases[`group:${group.id}`],
        titles: group.threadIds.map((id) => titles.get(id)),
      }));
    },
    posts: () => posts,
    modelPrompt: memberFixture.modelPrompt,
    modelRuns: memberFixture.modelRuns,
    async stop() {
      ui.deactivate('fixture');
      await contributions.deactivate('fixture');
      await activation.stop({ reason: 'test_complete' });
      await app.close();
      globalThis.fetch = originalFetch;
      await writeFile(
        join(artifactRoot, 'instance-ledger.json'),
        JSON.stringify(
          {
            ...ledger,
            state: 'stopped',
            stoppedAt: new Date().toISOString(),
            retained: 'archive, screenshots, synthetic journal and receipt; no native history',
          },
          null,
          2,
        ),
      );
    },
  };
}

export function withPrivatePngMetadata(png: Buffer): Buffer {
  const text = Buffer.from('Comment\0private-metadata-canary');
  const name = Buffer.from('tEXt');
  const bytes = Buffer.concat([name, text]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([png.subarray(0, 33), length, bytes, checksum, png.subarray(33)]);
}
