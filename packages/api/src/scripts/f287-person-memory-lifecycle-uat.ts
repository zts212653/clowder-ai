import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateF287RunId } from './f287-person-memory-lifecycle-uat-contract.js';
import { runF287PersonMemoryLifecycleUat } from './f287-person-memory-lifecycle-uat-journey.js';

export {
  buildF287AlphaOwnerFixture,
  type F287PersonMemoryLifecycleUatInput,
  type F287PersonMemoryLifecycleUatResult,
} from './f287-person-memory-lifecycle-uat-contract.js';
export {
  buildF287PersonMemoryProposalBody,
  runF287PersonMemoryLifecycleUat,
} from './f287-person-memory-lifecycle-uat-journey.js';

function runIdFromArgs(args: readonly string[]): string {
  const index = args.indexOf('--run-id');
  const runId = index >= 0 ? args[index + 1] : undefined;
  if (!runId) throw new Error('usage: f287-person-memory-lifecycle-uat --run-id <alpha-run-id>');
  return validateF287RunId(runId);
}

async function main(): Promise<void> {
  const result = await runF287PersonMemoryLifecycleUat({
    baseUrl: process.env.CAT_CAFE_API_URL ?? '',
    invocationId: process.env.CAT_CAFE_INVOCATION_ID ?? '',
    callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN ?? '',
    ownerUserId: process.env.CAT_CAFE_USER_ID ?? '',
    runId: runIdFromArgs(process.argv.slice(2)),
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'F287 alpha UAT failed');
    process.exitCode = 1;
  });
}
