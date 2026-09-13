#!/usr/bin/env node
/**
 * SUNSET (2026-09-09, origin↔upstream integration).
 *
 * This CLI previously rehearsed the runtime→workspace account-store cutover
 * (runtime-migration.json completion marker + migrate-on-read). That cutover is
 * gone: account roots use dual-root adjudication (primary workspace + optional
 * legacy runtime), ordinary reads are pure, and format migrations run only from
 * accountStartupHook / writeCatalogAccount / explicit migrateCatalogAccounts.
 *
 * Replacement verification:
 *   - packages/api/test/account-store-adjudication.test.js
 *   - packages/api/test/account-startup.test.js
 *   - packages/api/test/accounts-split-root.test.js (redirect / pure-read invariants)
 *
 * Exit 2 = gate untrustworthy / do not treat as a restart green light.
 */
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const MESSAGE = `[migration-dry-run] SUNSET: runtime→workspace cutover rehearsal is retired.
Upstream dual-root adjudication replaced migrate-on-read / runtime-migration.json.
Do not use this exit as a restart gate. See account-store-adjudication + account-startup tests.
`;

export function main() {
  process.stderr.write(MESSAGE);
  return 2;
}

if (isMain) {
  process.exit(main());
}
