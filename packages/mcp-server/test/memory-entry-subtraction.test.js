/**
 * 2026-11-09 记忆入口减法（第一刀）回归守护。
 *
 * You 11-09：「入口有点太多了，对猫来说是个很大的心智负担……有的是不是都已经不用了？应该把它给干掉」。
 * F152 全局蒸馏 operator 2026-08-29 已 sunset，三个工具从未被调用；retain_memory_callback 近 30 天 0 次。
 * 这四个入口从猫的工具面撤掉，服务端已有数据只停写、不删。
 * 证据：docs/evidence/2026-11-09-memory-tool-usage-census/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '../dist/server-toolsets.js';
import * as tools from '../dist/tools/index.js';

const RETIRED = [
  'cat_cafe_mark_generalizable', // mcp-cutover-negative-reference: absence
  'cat_cafe_nominate_for_global', // mcp-cutover-negative-reference: absence
  'cat_cafe_review_distillation', // mcp-cutover-negative-reference: absence
  'cat_cafe_retain_memory_callback', // mcp-cutover-negative-reference: absence
];

test('retired memory entries are not advertised to cats', () => {
  for (const name of RETIRED) {
    assert.equal(
      CANONICAL_TOOL_REGISTRY.some((definition) => definition.name === name),
      false,
      `${name} should no longer be in the canonical registry`,
    );
  }
});

test('the F152 distillation family has no cat-facing tools left', () => {
  const familyOf = (definition) => definition.policy.resourceFamily;
  assert.ok(
    CANONICAL_TOOL_REGISTRY.some((definition) => familyOf(definition) === 'person-memory'),
    'accessor sanity',
  );
  assert.deepEqual(
    CANONICAL_TOOL_REGISTRY.filter((definition) => familyOf(definition) === 'distillation').map((d) => d.name),
    [],
  );
});

test('retired handlers are no longer exported from the tool barrel', () => {
  for (const exportName of [
    'handleCallbackRetainMemory',
    'callbackRetainMemoryInputSchema',
    'handleMarkGeneralizable',
    'handleNominateForGlobal',
    'handleReviewDistillation',
    'distillationTools',
  ]) {
    assert.equal(exportName in tools, false, `${exportName} should be gone`);
  }
});

// 第二刀：资料库归档挪到主人页面（小星星 2026-11-09，thread_mw9jh0edn2fvrbny#0001794248398155-000431-329a2b2d）。
// 页面与原工具调同一条 POST /api/library/:id/archive；服务端路由不变。
test('library archive is no longer advertised as a cat tool', () => {
  assert.equal(
    CANONICAL_TOOL_REGISTRY.some((definition) => definition.name === 'cat_cafe_library_archive'), // mcp-cutover-negative-reference: absence
    false,
  );
  assert.equal('handleLibraryArchive' in tools, false);
  assert.equal('libraryArchiveInputSchema' in tools, false);
});
