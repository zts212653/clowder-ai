import { once } from 'node:events';
import { createPmPreparationProgramFixture } from './f311-preparation-workspace.journey.mjs';
import { startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';

await import('tsx');
const { default: programFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-fixtures.ts'
);
const { default: preparationFixtures } = await import(
  '../../src/components/capability-evolution/__tests__/evolution-preparation-fixtures.ts'
);
const { PROGRAM_ID, programFixture } = programFixtures;
const { evolutionPreparationFixture } = preparationFixtures;
const threadId = 'thread-f311-workspace-contract';
const webPort = Number(process.argv[2] ?? 5102);
const apiPort = Number(process.argv[3] ?? 3102);
const fixture = await startEvolutionWorkspaceBrowserFixture(
  createPmPreparationProgramFixture(programFixture, evolutionPreparationFixture, threadId),
  { webPort, apiPort },
);
const url = new URL(`/thread/${threadId}`, fixture.webUrl);
url.searchParams.set('evolutionProgram', PROGRAM_ID);
url.searchParams.set('evolutionView', 'judgment');
process.stdout.write(`${JSON.stringify({ status: 'running', url: url.href })}\n`);

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
await once(controller.signal, 'abort');
await fixture.close();
