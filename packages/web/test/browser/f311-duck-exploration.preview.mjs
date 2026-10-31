import { once } from 'node:events';
import { Server } from '../../../api/node_modules/socket.io/dist/index.js';
import * as fixturesImport from '../../src/components/capability-evolution/__tests__/evolution-fixtures.ts';
import * as dataImport from './f311-duck-exploration.data.mts';
import { CONTRACT_THREAD_ID, startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';

const { MOCK_PROGRAM_ID, mockExploration, mockObject, mockRef, mockSource } = dataImport.default ?? dataImport;
const { programFixture } = fixturesImport.default ?? fixturesImport;
const projection = programFixture('observing');
projection.program.programId = MOCK_PROGRAM_ID;
projection.program.workspaceId = 'user:default-user';
projection.program.displayName = '鸭鸭模拟进化 · mock';
projection.program.objectRef = mockObject;
projection.program.currentAssetVersionRefs = [];
projection.origin = { threadId: CONTRACT_THREAD_ID, title: '模拟项目，不派真实任务', createdByCatId: 'codex-astra' };
for (const cycle of projection.cycles) cycle.programId = MOCK_PROGRAM_ID;
const prefix = `/api/capability-evolution/programs/${encodeURIComponent(MOCK_PROGRAM_ID)}`;
const fixture = await startEvolutionWorkspaceBrowserFixture(projection, {
  webPort: Number(process.argv[2] ?? 5188),
  configureApi(api) {
    const socket = new Server(api);
    return () => new Promise((resolve) => socket.close(resolve));
  },
  async handleRequest({ request, url }) {
    if (!['GET', 'HEAD'].includes(request.method))
      return { status: 405, body: { error: 'mock_preview_read_only_no_real_action' } };
    if (url.pathname === `${prefix}/exploration`) {
      try {
        const selection = {};
        for (const key of ['selectedNodeRef', 'selectedExperimentRef', 'comparisonExperimentRef']) {
          if (url.searchParams.has(key)) selection[key] = JSON.parse(url.searchParams.get(key));
        }
        return { body: mockExploration(selection) };
      } catch {
        return { status: 400, body: { error: 'invalid_mock_selection' } };
      }
    }
    if (url.pathname === `${prefix}/asset-review`)
      return {
        body: {
          schemaVersion: 1,
          programRef: { ownerFeatureId: 'F311', ownerStateRef: MOCK_PROGRAM_ID },
          objectRef: mockObject,
          status: 'resolved',
          sourceRef: mockRef('no-real-owner-adoption'),
          readAt: '2026-09-20T01:50:00.000Z',
          currentVersionRefs: [],
          currentProofRef: mockRef('no-real-owner-adoption'),
          versions: [],
          blockers: [],
        },
      };
    const match = /^\/api\/mock-duck\/source\/(X[1-7])$/.exec(url.pathname);
    if (match) {
      const i = url.searchParams.has('case') ? Number(url.searchParams.get('case')) : undefined;
      if (i !== undefined && (!Number.isInteger(i) || i < 0 || i >= 8))
        return { status: 400, body: { error: 'invalid_case' } };
      return { body: mockSource(match[1], i) };
    }
    return undefined;
  },
});
const url = new URL(`/thread/${CONTRACT_THREAD_ID}`, fixture.webUrl);
url.searchParams.set('evolutionProgram', MOCK_PROGRAM_ID);
url.searchParams.set('evolutionView', 'judgment');
url.searchParams.set('mockExploration', '1');
console.log(JSON.stringify({ mode: 'production-exploration-components-with-mock-records', url: url.href }));
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
await once(controller.signal, 'abort');
await fixture.close();
