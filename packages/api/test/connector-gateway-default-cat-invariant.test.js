/**
 * #910 Invariant guard: connector gateway bootstrap MUST NOT hardcode a
 * legacy catId like `'opus'` for `defaultCatId`. It must source the default
 * from `getDefaultCatId()` (cat-config-loader), so production runtime
 * catalogs (where `'opus'` does not exist) don't fail with
 * `Unknown cat ID: opus` on no-mention IM messages.
 *
 * Bug report: https://github.com/zts212653/clowder-ai/issues/910
 * Root cause:
 *   packages/api/src/index.ts: `defaultCatId: 'opus' as CatId,`
 *   - parseMentions falls back to this when no @mention matches
 *   - ConnectorInvokeTrigger → routeExecution → service map lookup
 *   - With runtime catalog mapped to `cat-*` IDs, 'opus' is invalid
 *
 * This invariant test is the regression guard: future edits cannot
 * silently re-introduce a hardcoded breed/variant id without flipping
 * this assertion red.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS_PATH = resolve(__dirname, '../src/index.ts');

describe('#910: connector gateway bootstrap default catId invariant', () => {
  it("packages/api/src/index.ts does NOT hardcode `defaultCatId: 'opus'`", () => {
    const source = readFileSync(INDEX_TS_PATH, 'utf8');

    // Reject the exact pattern that produces the bug.
    // Tolerates whitespace, allows the type assertion `as CatId`.
    const hardcodedPattern = /defaultCatId\s*:\s*['"]opus['"](\s+as\s+CatId)?/;
    const match = source.match(hardcodedPattern);

    assert.equal(
      match,
      null,
      `index.ts must not hardcode defaultCatId to 'opus'. ` +
        `Production runtime catalogs use cat-* ids and break with 'Unknown cat ID: opus' ` +
        `on no-mention IM messages. Found: ${match?.[0]}. ` +
        `Use getDefaultCatId() from cat-config-loader instead.`,
    );
  });

  it('packages/api/src/index.ts uses getDefaultCatId() for connector gateway defaultCatId', async () => {
    const source = readFileSync(INDEX_TS_PATH, 'utf8');

    // Positive assertion: the connectorGatewayOptions block must reference
    // getDefaultCatId(). We search the whole file because the import + the
    // call site live on different lines.
    assert.match(source, /\bgetDefaultCatId\b/, 'index.ts must import getDefaultCatId from cat-config-loader');

    // Every `defaultCatId` site (value form OR `get defaultCatId()` form OR
    // function-reference form `defaultCatId: getDefaultCatId`) must resolve
    // through cat-config-loader. Cloud-P1 fix made the production site a
    // function reference (not a call) so ConnectorRouter can lazy-resolve
    // per-message and runtime PUT /api/config/default-cat propagates.
    const valueLines = source.match(/^.*\bdefaultCatId\s*:.*$/gm) ?? [];
    const getterIndex = source.search(/^\s*get\s+defaultCatId\s*\(/m);
    const getterBlock = getterIndex >= 0 ? source.slice(getterIndex, source.indexOf('}', getterIndex) + 1) : '';
    for (const line of valueLines) {
      assert.match(
        line,
        /\bgetDefaultCatId\b/,
        `Every defaultCatId assignment in index.ts must reference getDefaultCatId. Offending line: ${line.trim()}`,
      );
    }
    if (getterBlock) {
      assert.match(getterBlock, /\bgetDefaultCatId\b/, 'The `get defaultCatId()` body must use getDefaultCatId.');
    }
  });
});
