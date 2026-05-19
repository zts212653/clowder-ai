/**
 * F203 Phase D — root md 瘦身守护测试。
 *
 * L0 (assets/system-prompts/system-prompt-l0.md) 在 Phase C 接通 native
 * system role 后，CLAUDE.md / AGENTS.md 不再需要重复 identity/家规/SOP表/
 * 记忆详述/代码规范/文档表（L0 覆盖 OR ADR-030 §10.3 可从代码/文档重建）。
 * 本测试守护：(a) 行数 ≤ 65；(b) keep-anchor（harness-specific、L0 不含）
 * 仍在；(c) cut-section 标志已删；(d) 关键指针 1 行化仍指向真相源。
 *
 * 防"瘦身误删 keep-anchor"——Red 先行（当前 200/219 行必 fail）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
// wc -l semantics（AC-D1/D2 "≤65 行" = 实际行数）: a trailing newline
// (normal POSIX file end) must NOT inflate the count by a phantom empty
// segment. 云端 Codex P2 2026-05-16: split('\n').length overcounts by 1
// for trailing-newline files → false CI failure at exactly 65 real lines.
const lineCount = (s) => {
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
};

const MAX_LINES = 65;

test('CLAUDE.md ≤ 65 lines (AC-D1)', () => {
  const md = read('CLAUDE.md');
  assert.ok(lineCount(md) <= MAX_LINES, `CLAUDE.md must be ≤ ${MAX_LINES} lines, got ${lineCount(md)}`);
});

test('AGENTS.md ≤ 65 lines (AC-D2)', () => {
  const md = read('AGENTS.md');
  assert.ok(lineCount(md) <= MAX_LINES, `AGENTS.md must be ≤ ${MAX_LINES} lines, got ${lineCount(md)}`);
});

test('CLAUDE.md keeps harness-specific anchors L0 does NOT cover', () => {
  const md = read('CLAUDE.md');
  // C4 terse 铁律 (harness 第一读 P0 安全) / C7 闭环 / C8 布偶猫专属 dev 规则
  for (const anchor of [
    'Redis production Redis (sacred)',
    '流程闭环检查点',
    'SystemPromptBuilder 守护测试',
    'typescript-lsp',
  ]) {
    assert.ok(md.includes(anchor), `CLAUDE.md must keep harness anchor: "${anchor}"`);
  }
});

test('CLAUDE.md drops sections covered by L0 / rebuildable (ADR-030 §10.3)', () => {
  const md = read('CLAUDE.md');
  // C5 记忆详述 / C6 Knowledge Feed 完整段 / C2 队友静态表
  assert.ok(!md.includes('### 检索策略'), 'CLAUDE.md must drop memory-detail section (### 检索策略)');
  assert.ok(!md.includes('### 排序行为'), 'CLAUDE.md must drop memory-detail (### 排序行为)');
  assert.ok(!md.includes('### Knowledge Feed'), 'CLAUDE.md must drop full Knowledge Feed section (W7 in L0)');
  assert.ok(
    !md.includes('| 布偶猫 (Claude) | 宪宪 |'),
    'CLAUDE.md must drop static teammate roster table (SystemPromptBuilder dynamic)',
  );
});

test('CLAUDE.md keeps 1-line pointers to truth sources', () => {
  const md = read('CLAUDE.md');
  for (const ptr of ['docs/SOP.md', 'memory-routing-partial.md']) {
    assert.ok(md.includes(ptr), `CLAUDE.md must keep pointer to: "${ptr}"`);
  }
});

// F188 harness-consistency compat: even slimmed, root md must keep the
// 三入口 memory routing with FULL cat_cafe_* tool names (f188-harness-
// consistency.test.js FULL_REQUIRED_PHRASES). Lock it into Phase D's own
// guard so future slimming can't silently re-break F188.
test('root md keeps F188 三入口 full tool names (CLAUDE.md + AGENTS.md)', () => {
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const md = read(file);
    for (const phrase of [
      '三入口',
      'cat_cafe_graph_resolve',
      'cat_cafe_list_recent',
      'cat_cafe_search_evidence',
      'memory-routing-partial',
    ]) {
      assert.ok(md.includes(phrase), `${file} must keep F188 phrase: "${phrase}"`);
    }
  }
});

test('AGENTS.md keeps 缅因猫 harness anchors L0 does NOT cover', () => {
  const md = read('AGENTS.md');
  for (const anchor of ['严重度定义', 'Codex 沙盒']) {
    assert.ok(md.includes(anchor), `AGENTS.md must keep reviewer/codex anchor: "${anchor}"`);
  }
});

test('AGENTS.md drops sections covered by L0 / rebuildable', () => {
  const md = read('AGENTS.md');
  assert.ok(!md.includes('### 检索策略'), 'AGENTS.md must drop memory-detail section');
  assert.ok(!md.includes('### Knowledge Feed'), 'AGENTS.md must drop full Knowledge Feed section');
  assert.ok(!md.includes('| 缅因猫 (Codex) | 砚砚 |'), 'AGENTS.md must drop static teammate roster table');
});

test('AGENTS.md keeps 1-line pointers to truth sources', () => {
  const md = read('AGENTS.md');
  for (const ptr of ['docs/SOP.md', 'memory-routing-partial.md']) {
    assert.ok(md.includes(ptr), `AGENTS.md must keep pointer to: "${ptr}"`);
  }
});
