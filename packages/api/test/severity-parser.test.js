/**
 * F140 Phase E.1 — severity parser unit tests (TDD Red step first).
 *
 * Positive: 5 cases × 3 formats (badge / bracket / colon)
 * Negative (FP guards): 9 cases covering all critical false-positive sources
 *   — reason each negative exists called out inline.
 * getMaxSeverity: 3 cases.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getMaxSeverity, parseSeverity } from '../dist/infrastructure/email/severity-parser.js';

// ── Positive: shields.io badge ────────────────────────────────────

test('parseSeverity: shields.io badge — P0', () => {
  const body = '![P0 Badge](https://img.shields.io/badge/P0-red?style=flat) Critical';
  assert.equal(parseSeverity(body), 'P0');
});

test('parseSeverity: shields.io badge — P1', () => {
  const body = '![P1 Badge](https://img.shields.io/badge/P1-yellow?style=flat) Skip';
  assert.equal(parseSeverity(body), 'P1');
});

test('parseSeverity: shields.io badge — P2', () => {
  const body = '![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat) Minor';
  assert.equal(parseSeverity(body), 'P2');
});

// ── Positive: 行首方括号 / 行首冒号 ────────────────────────────────

test('parseSeverity: 行首方括号 [P2]', () => {
  assert.equal(parseSeverity('[P2] Minor issue detected'), 'P2');
});

test('parseSeverity: 行首冒号 P1:', () => {
  assert.equal(parseSeverity('P1: This needs to be fixed'), 'P1');
});

test('parseSeverity: 行首粗体冒号 **P1**:', () => {
  assert.equal(parseSeverity('**P1**: this is a real issue'), 'P1');
});

// ── Negative: FP guards (砚砚 KD-16 + GPT-5.5 P1-1) ──────────────

test('parseSeverity: 句内裸词 — "I think this is P1" → null', () => {
  assert.equal(parseSeverity('I think this is P1 but not sure'), null);
});

test('parseSeverity: P100 → null（超界不吃）', () => {
  assert.equal(parseSeverity('P100 users affected'), null);
});

test('parseSeverity: MP3 → null（含 P 字母的其他 token）', () => {
  assert.equal(parseSeverity('Upload MP3 file here'), null);
});

test('parseSeverity: fenced code block 内的 P1: → null', () => {
  const body = 'Example:\n```\nP1: old finding\n```\nend';
  assert.equal(parseSeverity(body), null);
});

test('parseSeverity: blockquote > P1: → null（引用旧 finding）', () => {
  const body = '> P1: previously reported\n\nNow addressed';
  assert.equal(parseSeverity(body), null);
});

// GPT-5.5 加的守护负例：防止老"过期 P1/P2 冒出来"结构性复发
test('parseSeverity: fenced code 内的 badge → null（老 bug 结构性复发守护）', () => {
  const body =
    'Here is an example:\n```\n![P1 Badge](https://img.shields.io/badge/P1-yellow?style=flat) old\n```\nNo severity now.';
  assert.equal(parseSeverity(body), null);
});

test('parseSeverity: blockquote 内的 badge → null（引用旧 finding 不触发）', () => {
  const body = '> ![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat) previously addressed\n\nNow fixed';
  assert.equal(parseSeverity(body), null);
});

test('parseSeverity: P3 不识别（informational）→ null', () => {
  assert.equal(parseSeverity('[P3] FYI — consider naming'), null);
});

test('parseSeverity: 空 body → null', () => {
  assert.equal(parseSeverity(''), null);
});

// ── P0 fix (云端 codex 2026-04-24)：单 body 多 severity 取最高 ──────

test('parseSeverity: 单 body 内 [P2] 先于 **P0**: → P0 (max across markers)', () => {
  // Pre-fix bug: returns P2 because bracket regex hits first (before colon)
  const body = '[P2] naming nit on line 10\n\n**P0**: null pointer crash on line 42';
  assert.equal(parseSeverity(body), 'P0');
});

test('parseSeverity: 单 body 内 P1: 先于 badge P0 → P0 (max across markers)', () => {
  const body = 'P1: race condition observed\n\n![P0 Badge](https://img.shields.io/badge/P0-red) data loss';
  assert.equal(parseSeverity(body), 'P0');
});

test('parseSeverity: 单 body 内 [P2] [P1] [P0] 任意顺序 → P0', () => {
  const body = '[P2] nit\n[P1] minor\n[P0] critical';
  assert.equal(parseSeverity(body), 'P0');
});

// ── getMaxSeverity aggregation ─────────────────────────────────────

test('getMaxSeverity: P2 + P1 + P0 → P0（最高）', () => {
  const comments = [{ body: '[P2] a' }, { body: '[P1] b' }];
  const decisions = [{ body: '**P0**: critical' }];
  assert.equal(getMaxSeverity(comments, decisions), 'P0');
});

test('getMaxSeverity: all empty → null', () => {
  assert.equal(getMaxSeverity([], []), null);
});

test('getMaxSeverity: 无匹配 → null', () => {
  const comments = [{ body: 'looks good' }];
  assert.equal(getMaxSeverity(comments, []), null);
});
