/** Read-only: inspect local files and optionally the running API; never migrate or control processes. */
import { AccountStoreVerdictError } from '../../config/account-store-format.js';
import {
  inspectRuntimeAccountBindings,
  newlyRejectedRuntimeBindings,
  readLiveAccountAvailability,
} from '../../config/runtime-account-preflight.js';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--api-port');
const allowRegression = args.includes('--allow-account-regression');

try {
  const root = process.env.CAT_CAFE_RUNTIME_ROOT?.trim() || process.cwd();
  const result = inspectRuntimeAccountBindings(root);
  const live = portIndex < 0 ? undefined : await readLiveAccountAvailability(Number(args[portIndex + 1]));
  const newRejections = live ? newlyRejectedRuntimeBindings(result, live) : result.rejectedBindings;
  const blocked = newRejections.length > 0 && !allowRegression;
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, live, newRejections, blocked, allowRegression })}\n`);
  } else {
    for (const item of result.unboundRejectedAccounts) {
      console.warn(`[accounts] unused/unavailable member account ${JSON.stringify(item.accountRef)}: ${item.reason}`);
    }
    for (const item of newRejections) {
      console.error(`[accounts] ${JSON.stringify(item.catId)} → ${JSON.stringify(item.accountRef)}: ${item.reason}`);
    }
    if (live?.state === 'unreachable') {
      console.warn('[accounts] Live availability unknown (cold start or failed probe); continuing partial startup.');
      for (const item of result.rejectedBindings)
        console.warn(`[accounts] ${JSON.stringify(item.catId)}: ${item.reason}`);
    } else if (blocked) {
      console.error(
        'Replacement would make the listed members newly unavailable; existing processes were not stopped.',
      );
      console.error('Reconcile these accounts, or explicitly accept this loss with --allow-account-regression.');
    } else if (newRejections.length > 0) {
      console.warn('[accounts] --allow-account-regression explicitly accepts the listed availability loss.');
    } else {
      console.log(`[accounts] No new account rejection; ${result.rejectedBindings.length} existing rejections remain.`);
    }
  }
  if (blocked) process.exitCode = 2;
} catch (error) {
  const detail = error instanceof AccountStoreVerdictError ? error.message : 'catalog/account inspection failed';
  console.error(`[accounts] Pre-activation inspection unknown: ${detail}. No availability claim can be made.`);
  // The standalone diagnostic reports failure; a launcher maps this unknown to
  // an explicit warning so a diagnostic fault cannot prevent recovery startup.
  process.exitCode = 1;
}
