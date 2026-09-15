import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from '../../../api/node_modules/fastify/fastify.js';
import { explorationFixture, source } from '../../../api/test/capability-evolution-exploration.helper.mjs';
import { CONTRACT_THREAD_ID, startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';
import { createMicroduckProgramFixture } from './f311-workspace-owner-reading.journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CODE_ID = 'evolution-program:c0dec0dec0dec0dec0dec0dec0dec0de';
const load = async (file) => {
  const value = await import(pathToFileURL(path.resolve(ROOT, file)).href);
  return value.default ?? value;
};

async function codePublication(routes, codeProgram) {
  const probe = Fastify();
  await probe.register(routes, { service: { get: async () => codeProgram } });
  const uri = `/api/capability-evolution/programs/${encodeURIComponent(codeProgram.program.programId)}/exploration`;
  const response = await probe.inject({ url: uri });
  await probe.close();
  const file = 'packages/api/src/routes/capability-evolution-exploration-routes.ts';
  const revision = createHash('sha256')
    .update(await readFile(path.join(ROOT, file)))
    .digest('hex');
  const fixture = explorationFixture({ withDetail: true });
  const observedAt = new Date().toISOString();
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const testedVersion = source('tested-route-file', revision);
  const testedAsset = { ...testedVersion, assetKind: 'code', assetId: file };
  const invocation = source(
    'isolated-invocation',
    digest({ uri, revision, observedAt, status: response.statusCode, body: response.body }),
  );
  const responseRef = source('actual-response', digest({ uri, status: response.statusCode, body: response.body }));
  fixture.programRef.ownerStateRef = codeProgram.program.programId;
  fixture.objectRef = codeProgram.program.objectRef;
  fixture.readAt = observedAt;
  fixture.sourceRef = invocation;
  fixture.nodes[0].nodeRef = testedAsset;
  fixture.nodes[0].versionRef = testedAsset;
  fixture.nodes[0].title = '身份读取守卫';
  fixture.nodes[0].summary = '从真实 API handler 的隔离调用读取输入与响应；不代表生产效用。';
  fixture.nodes[0].sourceRef = source('tested-route-file', revision);
  fixture.experiments[0].title = '未登录读取 · 实际隔离调用';
  fixture.experiments[0].nodeRef = testedAsset;
  fixture.experiments[0].experimentRef = invocation;
  fixture.experiments[0].sourceRef = invocation;
  fixture.experiments[0].conditions.window.sourceRef = invocation;
  fixture.experiments[0].conditions.window.detail = `${observedAt}，直到真实 handler 返回响应。`;
  fixture.details[0].experimentRef = invocation;
  fixture.details[0].nodeRef = testedAsset;
  const record = fixture.details[0].records[0];
  record.recordRef = invocation;
  record.experimentRef = invocation;
  record.nodeRef = testedAsset;
  record.windowRef = invocation;
  record.evidenceRef = responseRef;
  record.sources = [{ label: '本次实际请求与响应摘要', ref: responseRef }];
  record.input = [
    { label: '请求', value: `GET ${uri}` },
    { label: '身份', value: '无登录态，无 callback principal' },
  ];
  record.output = [
    { label: 'HTTP 状态', value: String(response.statusCode) },
    { label: '响应正文', value: response.body },
  ];
  record.values.status = response.statusCode;
  record.result = {
    status: response.statusCode === 401 ? 'satisfied' : 'violated',
    label: response.statusCode === 401 ? '未登录读取被拒绝' : '读取未被正确拒绝',
  };
  record.sources.push({ label: '被测 handler 源码修订', ref: source('tested-route-file', revision) });
  return fixture;
}

/** Real F307 shell and real authenticated exploration handlers; isolated Program/delivery state only. */
export async function startExplorationBrowserFixture(options = {}) {
  const { programFixture } = await load(
    'packages/web/src/components/capability-evolution/__tests__/evolution-fixtures.ts',
  );
  const { capabilityEvolutionProgramRoutes } = await load(
    'packages/api/src/routes/capability-evolution-program-routes.ts',
  );
  const { createMicroduckLocalOwnerBindings } = await load(
    'packages/api/src/infrastructure/capability-evolution/adapters/microduck-local-owner.ts',
  );
  const duck = createMicroduckProgramFixture(() => programFixture('observing'));
  duck.program.workspaceId = 'user:default-user';
  duck.program.displayName = '鸭鸭踢球 · 探索记录';
  duck.origin = { threadId: CONTRACT_THREAD_ID, title: '看清接近路线与踢球得失', createdByCatId: 'codex-sol' };
  const code = JSON.parse(JSON.stringify(programFixture('observing')).replaceAll(duck.program.programId, CODE_ID));
  code.program.workspaceId = 'user:default-user';
  code.program.displayName = '代码行为 · 身份读取';
  code.program.objectRef = { ownerFeatureId: 'F100', ownerStateRef: 'capability:code-behavior' };
  code.origin = { threadId: CONTRACT_THREAD_ID, title: '读取必须尊重实际身份', createdByCatId: 'codex-sol' };
  const programs = new Map([duck, code].map((value) => [value.program.programId, value]));
  const capturedCode = await codePublication(capabilityEvolutionProgramRoutes, code);
  let corruptRun;
  const originalBindings = createMicroduckLocalOwnerBindings({
    repoRoot: ROOT,
    readBytes: async (file) => {
      const bytes = await readFile(file);
      return corruptRun && file.endsWith('.json.gz') && file.includes(`/evidence/${corruptRun}/`)
        ? Buffer.concat([bytes, Buffer.from([1])])
        : bytes;
    },
  });
  let withdrawnMedia;
  let explorationAvailable = true;
  const bindings = {
    ...originalBindings,
    explorationReview: async (input) => {
      const review = await originalBindings.explorationReview(input);
      if (review.status === 'resolved' && withdrawnMedia) {
        for (const detail of review.details)
          if (detail.status === 'resolved')
            for (const record of detail.records)
              record.media = record.media.filter((entry) => entry.mediaRef.version !== withdrawnMedia);
      }
      return review;
    },
  };
  let mediaAvailable = true;
  let access = true;
  let loseResponse = false;
  const messages = new Map();
  const writes = [];
  const codeAdapter = {
    explorationReview: async (input) => ({
      ...capturedCode,
      details: input.selectedExperimentRef ? capturedCode.details : [],
    }),
  };
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    if (access) request.sessionUserId = 'default-user';
    done();
  });
  await app.register(capabilityEvolutionProgramRoutes, {
    service: { get: async (id) => programs.get(id), list: async () => [...programs.values()] },
    resolveOrigin: async (program) => programs.get(program.programId)?.origin,
    adapterRegistry: {
      resolve: (ref) => ({
        status: 'resolved',
        adapter: ref.ownerFeatureId === 'microduck-owner' ? bindings : codeAdapter,
      }),
    },
  });
  const fixture = await startEvolutionWorkspaceBrowserFixture(duck, {
    ...options,
    handleRequest: async ({ request, url }) => {
      if (url.pathname === '/api/messages' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        writes.push(body);
        if (!messages.has(body.idempotencyKey))
          messages.set(body.idempotencyKey, {
            status: 'queued',
            userMessageId: `isolated-message-${messages.size + 1}`,
          });
        if (loseResponse) {
          loseResponse = false;
          return { status: 503, body: { error: 'isolated_response_lost_after_recording' } };
        }
        return { status: 202, body: messages.get(body.idempotencyKey) };
      }
      if (!url.pathname.startsWith('/api/capability-evolution/programs')) return undefined;
      if (!explorationAvailable && url.pathname.endsWith('/exploration'))
        return { status: 503, body: { error: 'isolated_transport_outage' } };
      if (!mediaAvailable && url.pathname.includes('/exploration-media/'))
        return { status: 503, body: { error: 'isolated_source_unavailable' } };
      const response = await app.inject({ url: `${url.pathname}${url.search}`, method: request.method });
      const binary = /^(image|video)\//.test(response.headers['content-type'] ?? '');
      return {
        status: response.statusCode,
        contentType: response.headers['content-type'],
        body: binary ? response.rawPayload : response.json(),
        binary,
      };
    },
  });
  return {
    ...fixture,
    duck,
    code,
    writes,
    messages,
    capturedCode,
    corruptExperiment: (ref) => {
      corruptRun = ref ? /^public-run-(.+):sha256:/.exec(ref.ownerStateRef)?.[1] : undefined;
      if (ref && !corruptRun) throw new Error('test fault must name a published football run');
    },
    setMediaAvailable: (value) => {
      mediaAvailable = value;
    },
    setExplorationAvailable: (value) => {
      explorationAvailable = value;
    },
    withdrawMedia: (sha256) => {
      withdrawnMedia = sha256;
    },
    setAccess: (value) => {
      access = value;
    },
    loseNextResponse: () => {
      loseResponse = true;
    },
    close: async () => {
      await fixture.close();
      await app.close();
    },
  };
}
