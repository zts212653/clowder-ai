import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PUBLISHED_COMPANION_V2,
  resolveCompanionArchiveContract,
} from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';

// B source1319: these published bytes, not bridgeVersion 1.3, identify the modern ABI.
const modern = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.14',
  packageDigest: 'sha512-aAJpJMjU20QtHaVY40LnJYHCVkJdqtJd1+3wGPjLgK/7sF9wxObc6y8udJKgXFOC0RqPy4MlQM35tCbE03YkAA==',
};

test('the exact published modern archive selects beta.23 while alpha.13 preserves beta.21', () => {
  assert.equal(resolveCompanionArchiveContract(modern), '0.1.0-beta.23');
  assert.equal(
    resolveCompanionArchiveContract({ pluginId: 'official.companion', ...PUBLISHED_COMPANION_V2 }),
    '0.1.0-beta.21',
  );
});

test('cross-paired versions or digests cannot select either companion ABI', () => {
  for (const candidate of [
    { ...modern, packageDigest: PUBLISHED_COMPANION_V2.packageDigest },
    { ...modern, version: PUBLISHED_COMPANION_V2.version },
    { ...modern, pluginId: 'package.other' },
    { ...modern, version: '0.1.0-alpha.15' },
    { ...modern, packageDigest: `${modern.packageDigest.slice(0, -5)}AAAA=` },
  ])
    assert.equal(resolveCompanionArchiveContract(candidate), undefined);
});
