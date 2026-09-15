import { once } from 'node:events';
import { startExplorationBrowserFixture } from './f311-exploration-workspace.harness.mjs';

await import('tsx');
const fixture = await startExplorationBrowserFixture({
  webPort: Number(process.argv[2] ?? 5182),
  apiPort: Number(process.argv[3] ?? 3182),
});
const url = new URL('/thread/thread-f311-workspace-contract', fixture.webUrl);
url.searchParams.set('evolutionProgram', fixture.duck.program.programId);
url.searchParams.set('evolutionView', 'judgment');
process.stdout.write(`${JSON.stringify({ mode: 'isolated-programs-real-owner-data', url: url.href })}\n`);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
await once(controller.signal, 'abort');
await fixture.close();
