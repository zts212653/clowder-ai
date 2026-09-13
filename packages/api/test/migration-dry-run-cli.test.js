/**
 * SUNSET (2026-09-09): the runtime→workspace migration dry-run CLI gate is
 * retired. Upstream dual-root adjudication replaced cutover; ordinary reads are
 * pure; format migrations run only from accountStartupHook / write / explicit
 * migrateCatalogAccounts. Replacement coverage lives in
 * account-store-adjudication.test.js + account-startup.test.js.
 *
 * This suite locks the retirement so public gate no longer exercises the old
 * marker/migrate-on-read contract, and so a resurrected cutover script fails
 * closed with an explicit exit.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'migration-dry-run.mjs');
const CATALOG_SRC = join(__dirname, '..', 'src', 'config', 'catalog-accounts.ts');
const TOPOLOGY_SRC = join(__dirname, '..', 'src', 'config', 'account-store-topology.ts');

describe('migration-dry-run CLI gate (sunset)', () => {
  it('catalog migrateCatalogAccounts no longer performs runtime→workspace cutover', () => {
    const src = readFileSync(CATALOG_SRC, 'utf-8');
    assert.equal(src.includes('runtime-migration.json'), false, 'retired completion marker must stay gone');
    assert.match(src, /Ordinary reads are pure/);
    assert.match(src, /never cut over runtime data/);
  });

  it('topology documents that account roots do not cut over', () => {
    const src = readFileSync(TOPOLOGY_SRC, 'utf-8');
    assert.match(src, /no general data-root migration, copy or cutover/);
  });

  it('the retired CLI exits 2 with an explicit sunset message (never a silent no-op)', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--workspace', '/tmp', '--runtime', '/tmp'], {
      encoding: 'utf-8',
      env: { ...process.env },
    });
    assert.equal(res.status, 2, `sunset gate must fail closed, got ${res.status}\n${res.stdout}${res.stderr}`);
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /SUNSET|retired|dual-root adjudication/i);
    assert.equal(/OK\b.*no-op/i.test(out), false, 'must never print a false no-op green light');
  });
});
