import { once } from 'node:events';
import { startObjectFirstPreview } from './f311-object-first-preview.fixture.mjs';
import { readableChoiceBodies } from './f311-readable-choices.bodies.mjs';
import { CONTRACT_THREAD_ID } from './f311-workspace-browser.harness.mjs';

const fixture = await startObjectFirstPreview({
  bodies: await readableChoiceBodies(),
  webPort: Number(process.argv[2] ?? 5321),
  apiPort: Number(process.argv[3] ?? 3322),
  browserApiUrl: process.env.F311_PREVIEW_BROWSER_ORIGIN,
});
const urls = Object.fromEntries(
  ['duck', 'memory'].map((key) => {
    const url = new URL(`/thread/${CONTRACT_THREAD_ID}`, fixture.webUrl);
    url.searchParams.set('evolutionProgram', fixture[key].program.programId);
    url.searchParams.set('evolutionView', 'judgment');
    return [key, url.href];
  }),
);
process.stdout.write(
  `${JSON.stringify({ status: 'running', mode: 'isolated-readability-draft-not-production', urls })}\n`,
);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
await once(controller.signal, 'abort');
await fixture.close();
