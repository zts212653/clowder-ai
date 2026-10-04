import { once } from 'node:events';
import { startSolutionFixture } from './f311-solution.fixture.mjs';

const fixture = await startSolutionFixture({ webPort: Number(process.argv[2] ?? 5183) });
process.stdout.write(`${JSON.stringify({ status: 'running', mode: 'isolated-design-only', url: fixture.url })}\n`);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
await once(controller.signal, 'abort');
await fixture.close();
