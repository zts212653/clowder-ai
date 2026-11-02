import { pathToFileURL } from 'node:url';
import { piErrorExcerpt } from './pi-rpc-diagnostics.js';
import { assertPiHistoryIntegrity } from './pi-session-integrity.js';
import { acquirePiWriterLease } from './pi-session-lease.js';
import type { PiSessionSlot } from './pi-session-store.js';

try {
  const [input, entry, ...args] = process.argv.slice(2);
  if (!input || !entry) throw new Error('Pi writer launch is incomplete');
  const slot = JSON.parse(input) as PiSessionSlot;
  const database = acquirePiWriterLease(slot);
  // Keep a strong reference throughout the real Pi lifetime (including after the bridge dies).
  process.once('exit', () => database.close());
  await assertPiHistoryIntegrity(slot);
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
} catch (error) {
  // Never emit module paths, argv, raw loader/SQLite errors or credentials.
  const message =
    error instanceof Error && /^(?:Pi |Persistent Pi requires)/.test(error.message)
      ? error.message
      : 'Pi persistent writer could not start; check Node 24, storage permissions and the installed Pi CLI';
  process.stderr.write(`${piErrorExcerpt(message)}\n`);
  process.exitCode = 1;
}
