import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findForbiddenProductTerms, scanF290ProductCopy } from './check-f290-product-copy.mjs';

test('findForbiddenProductTerms catches every internal design term', () => {
  const terms = ['镜片', 'canonical', '判断门', 'inspector', 'Gate', 'endpoint', '望窗', 'lineage', '轨迹层'];
  for (const term of terms) {
    assert.deepEqual(findForbiddenProductTerms(`用户界面里出现 ${term}`), [term.toLowerCase()]);
  }
});

test('the F290 asset page has no forbidden product copy', () => {
  assert.deepEqual(scanF290ProductCopy(), []);
});
