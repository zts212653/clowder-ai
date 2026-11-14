/**
 * F314-9: stable-JSON and fingerprint bytes are a contract, not an implementation detail.
 *
 * Pins today's bytes and key order for the stored digests (MCP drift hash, host-broker ledger
 * keys) and the two exported canonicalJson helpers. Merging these implementations or changing a
 * key order must change these values on purpose, together with a versioned migration for the
 * stored ones (plan: zts212653/clowder-ai#6456).
 *
 * The inputs mix upper- and lower-case keys on purpose: localeCompare puts `a` before `Z`,
 * code-unit order puts `Z` first, and both orders are in use today. localeCompare also follows
 * the process's collation locale (lt-LT sorts `y` like `i`), so every value is computed in a
 * child process with a pinned locale rather than under whatever locale runs the suite.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

const modules = {
  account: new URL('../dist/config/account-store-format.js', import.meta.url).href,
  mcp: new URL('../dist/mcp/mcp-sync-engine.js', import.meta.url).href,
  broker: new URL('../dist/domains/plugin/host-broker/canonical-json.js', import.meta.url).href,
};
const MARKER = 'F314_STABLE_JSON_BYTES ';

/** Every pinned value, computed by the production helpers in a process whose collation locale is `locale`. */
function bytesUnder(locale) {
  const script = `
const sample = { Z: 1, a: { y: [{ d: 1, C: 2 }], X: null }, b: 'text' };
const entries = [
  { id: 'beta', type: 'mcp', mcpServer: { command: 'node', args: ['b.js'], Env: { Z: '1', a: '2' } } },
  { id: 'Alpha', type: 'mcp', mcpServer: { command: 'node', args: ['a.js'] }, globalEnabled: false },
];
const { canonicalJson: account } = await import(${JSON.stringify(modules.account)});
const { canonicalJson: mcp, computeGlobalMcpHash } = await import(${JSON.stringify(modules.mcp)});
const { digestBrokerValue } = await import(${JSON.stringify(modules.broker)});
process.stdout.write('\\n${MARKER}' + JSON.stringify({
  collation: new Intl.Collator().resolvedOptions().locale,
  account: account(sample),
  mcp: mcp(sample),
  digest: digestBrokerValue(sample),
  ledgerKey: digestBrokerValue(['plugin-1', 'tool.call', { Z: 1, a: 2 }]),
  mcpHash: computeGlobalMcpHash(entries),
}) + '\\n');
`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LC_ALL: locale, LANG: locale },
    encoding: 'utf8',
  });
  const line = output.split('\n').find((l) => l.startsWith(MARKER));
  assert.ok(line, `no result from the ${locale} child process:\n${output}`);
  return JSON.parse(line.slice(MARKER.length));
}

// The historical bytes: home machines run en/zh locales, which order these ASCII keys like en-US.
const en = bytesUnder('en_US.UTF-8');

describe('F314-9 stable JSON bytes (locked, collation pinned to en-US)', () => {
  it('runs the pinned values under en-US collation', () => {
    assert.equal(en.collation, 'en-US');
  });

  it('account-store canonicalJson sorts keys with localeCompare', () => {
    assert.equal(en.account, '{"a":{"X":null,"y":[{"C":2,"d":1}]},"b":"text","Z":1}');
  });

  it('mcp-sync canonicalJson sorts keys in code-unit order', () => {
    assert.equal(en.mcp, '{"Z":1,"a":{"X":null,"y":[{"C":2,"d":1}]},"b":"text"}');
  });

  it('host-broker digests (stored as ledger keys) keep their bytes', () => {
    assert.equal(en.digest, '80cb2c40faf5687ea363e748e5c56275d4c3d2bcb013aa49156e0a77d04c76a3');
    assert.equal(en.ledgerKey, '6e103efdbb2c09e1b36903bbd0f032277147b875ea247f52f7dbafd8e690901d');
  });

  it('the stored MCP drift hash keeps its bytes (entries by localeCompare id, keys in code-unit order)', () => {
    assert.equal(en.mcpHash, 'fce84f0b5031fa9e');
  });

  it('code-unit order ignores the locale; localeCompare order follows it (a migration hazard, not fixed here)', (t) => {
    const lt = bytesUnder('lt_LT.UTF-8');
    assert.equal(lt.mcp, en.mcp);
    if (lt.collation !== 'lt-LT') {
      t.skip(`this Node build has no lt-LT collation data (got ${lt.collation})`);
      return;
    }
    assert.equal(lt.account, '{"a":{"y":[{"C":2,"d":1}],"X":null},"b":"text","Z":1}');
    assert.notEqual(lt.digest, en.digest);
  });
});
