import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Server } from '../../../api/node_modules/socket.io/dist/index.js';
import { CONTRACT_THREAD_ID, startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';

const fixturesModule = await import('../../src/components/capability-evolution/__tests__/evolution-fixtures.ts');
const { programFixture } = fixturesModule.default ?? fixturesModule;
const exampleModule = await import('../../src/components/capability-evolution/solution-gate/solution-example.ts');
const { SOLUTION_PREVIEW_ID } = exampleModule.default ?? exampleModule;

const football = 'docs/videos/f311-microduck-roadshow/pipeline/football/';
const sources = {
  'archive-index': { title: 'v8 真实运行索引 · 2026-09-09', path: `${football}evidence/20260909-short-v8/index.json` },
  'archive-frame': {
    title: 'v8 · 右侧更宽 · 20 秒真实归档帧',
    path: `${football}evidence/20260909-short-v8/position-right-wider-t200.png`,
    image: true,
  },
  'archive-summary': {
    title: 'v4 与 v8 公开对照 · 原始说明',
    path: `${football}readiness/20260909-short-approach/README.md`,
  },
};
const repo = new URL('../../../../', import.meta.url);

/** Read-only fixture server. Does not start production API, Redis, owner execution, or Program writers. */
export async function startSolutionFixture(options = {}) {
  const projection = programFixture('observing');
  projection.program.programId = SOLUTION_PREVIEW_ID;
  projection.program.workspaceId = 'user:default-user';
  projection.program.displayName = '鸭鸭协同踢球 · 设计示例';
  projection.program.objectRef = { ownerFeatureId: 'F311', ownerStateRef: 'design:solution-lineage' };
  projection.program.currentAssetVersionRefs = [];
  projection.origin = {
    threadId: CONTRACT_THREAD_ID,
    title: '整体方案谱系 · 隔离设计预览',
    createdByCatId: 'codex-astra',
  };
  for (const cycle of projection.cycles) cycle.programId = SOLUTION_PREVIEW_ID;
  const writes = [];
  const fixture = await startEvolutionWorkspaceBrowserFixture(projection, {
    ...options,
    configureApi(api) {
      const socket = new Server(api);
      return () => new Promise((resolve) => socket.close(resolve));
    },
    async handleRequest({ request, url }) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writes.push({ method: request.method, path: url.pathname });
        return { status: 405, body: { error: 'design_fixture_read_only' } };
      }
      const sourceMatch = /^\/api\/design\/f311-solution\/(source|asset)\/([a-z-]+)$/.exec(url.pathname);
      if (!sourceMatch) return undefined;
      const [, kind, id] = sourceMatch;
      const source = sources[id];
      if (!source) return { status: 404, body: { error: 'unknown_fixed_source' } };
      const bytes = await readFile(new URL(source.path, repo));
      if (kind === 'asset')
        return source.image
          ? { body: bytes, binary: true, contentType: 'image/png' }
          : { status: 404, body: { error: 'not_an_image' } };
      return {
        body: {
          title: source.title,
          path: source.path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          content: source.image ? '' : bytes.toString('utf8'),
          ...(source.image ? { imageUrl: `/api/design/f311-solution/asset/${id}` } : {}),
        },
      };
    },
  });
  const url = new URL(`/thread/${CONTRACT_THREAD_ID}`, fixture.webUrl);
  url.searchParams.set('solutionGate', '1');
  url.searchParams.set('evolutionProgram', SOLUTION_PREVIEW_ID);
  url.searchParams.set('evolutionView', 'judgment');
  return { ...fixture, url: url.href, writes };
}
