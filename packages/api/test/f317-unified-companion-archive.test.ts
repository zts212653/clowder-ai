import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PUBLISHED_COMPANION_V2,
  resolveCompanionArchiveContract,
} from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';

// B source2099: only this immutable version + digest may select the unified public ABI.
const unified = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.15',
  packageDigest: 'sha512-jbJNGzP5I2XpnlL38FA9xb+bFyfUoL+TojPaOdoKZ9IzPxeZynJoa1ti10HQL2Ajw/nutDy22OC7wxM9EJBY1w==',
};
// CVO845 / public PR73: the published return-control bytes keep beta.24.
const subtitleReturn = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.19',
  packageDigest: 'sha512-8z1dZ4qLtSMBw9vEwpXY4xDOfO2tjD+SXeY5QkusMQRu1/vIErf9y5osR1KjT5UdsHkaosS/H48XoJxW+iD/FA==',
};
const modern = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.14',
  packageDigest: 'sha512-aAJpJMjU20QtHaVY40LnJYHCVkJdqtJd1+3wGPjLgK/7sF9wxObc6y8udJKgXFOC0RqPy4MlQM35tCbE03YkAA==',
};

test('the exact published unified archive selects beta.24 explicitly', () => {
  assert.equal(resolveCompanionArchiveContract(unified), '0.1.0-beta.24');
});

test('the published subtitle-return archive selects beta.24 without replacing alpha.15', () => {
  assert.equal(resolveCompanionArchiveContract(subtitleReturn), '0.1.0-beta.24');
  assert.equal(resolveCompanionArchiveContract(unified), '0.1.0-beta.24');
});

test('subtitle-return admission rejects cross-pairs, unpublished bytes and adjacent versions', () => {
  for (const candidate of [
    { ...subtitleReturn, packageDigest: unified.packageDigest },
    { ...unified, packageDigest: subtitleReturn.packageDigest },
    { ...subtitleReturn, packageDigest: modern.packageDigest },
    { ...subtitleReturn, pluginId: 'foreign.companion' },
    { ...subtitleReturn, version: '0.1.0-alpha.18' },
    { ...subtitleReturn, version: '0.1.0-alpha.20' },
    {
      ...subtitleReturn,
      packageDigest: 'sha512-LzuWuKDkv1a9YWjqkRURY63ow0svVXqWJQbc6mb3knWCsYcIvtvpjqLLtQua0WSvG3LLi2Gnwp5CMFIYVB5OXw==',
    },
  ])
    assert.equal(resolveCompanionArchiveContract(candidate), undefined);
});

test('the landed alpha.14/beta.23 and alpha.13/beta.21 pairs remain unchanged', () => {
  assert.equal(resolveCompanionArchiveContract(modern), '0.1.0-beta.23');
  assert.equal(
    resolveCompanionArchiveContract({ pluginId: 'official.companion', ...PUBLISHED_COMPANION_V2 }),
    '0.1.0-beta.21',
  );
});

test('a cross-paired version, digest or foreign plugin cannot gain the unified ABI', () => {
  for (const candidate of [
    { ...unified, packageDigest: modern.packageDigest },
    { ...unified, version: modern.version },
    { ...unified, packageDigest: PUBLISHED_COMPANION_V2.packageDigest },
    { ...unified, version: PUBLISHED_COMPANION_V2.version },
    { ...unified, pluginId: 'foreign.companion' },
    { ...unified, packageDigest: `${unified.packageDigest.slice(0, -5)}AAAA=` },
  ])
    assert.equal(resolveCompanionArchiveContract(candidate), undefined);
});
