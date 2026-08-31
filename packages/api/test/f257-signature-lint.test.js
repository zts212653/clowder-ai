/**
 * F257 修复清单 #4 — message-signature structural lint (O2→O1), detection layer.
 *
 * 真相源：docs/features/F257-harness-ledger.md L198 + governance-l0「用自己的身份
 * 签名 [昵称/模型🐾]，签名必须含模型型号」。`lintCatSignature` 是 COMPLIANCE lint：
 * 断言消息末行是否为**当前契约形态** `[nickname/model🐾]`（nickname + '/' + model
 * + 🐾）。
 *
 * STRICTNESS（sol R1 P1-3）：不复用 `isCatSignatureLine`（routing 的 permissive
 * STRIP matcher，容忍 `[Spark🐾]` 无模型、`[砚砚/GPT-5.5]` 无爪）——那会把无模型/
 * 无爪签名误判为 compliant（false negative）。strip=permissive(routing) 与
 * lint=strict(compliance) 分离。presence-only（契约 SHAPE 在场），identity-
 * correctness（签名匹配发帖猫）仍 deferred。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  lintCatSignature,
  signatureLintExtra,
} from '../dist/domains/cats/services/agents/routing/cat-signature-lint.js';

describe('F257 #4 — lintCatSignature (strict [nickname/model🐾] compliance lint)', () => {
  // --- 正例：契约形态 nickname/model🐾 ---
  test('契约形态 [宪宪/claude-opus-4-8🐾] → signed，返回 trimmed 签名行', () => {
    const r = lintCatSignature('Some review text.\n\n[宪宪/claude-opus-4-8🐾]');
    assert.equal(r.signed, true);
    assert.equal(r.signatureLine, '[宪宪/claude-opus-4-8🐾]');
  });

  test('契约形态 [烁烁/Gemini-25🐾]（模型含 dash）→ signed', () => {
    assert.equal(lintCatSignature('done\n\n[烁烁/Gemini-25🐾]').signed, true);
  });

  test('契约形态 [砚砚/gpt-5.6-sol🐾]（模型含 dash+dot）→ signed', () => {
    assert.equal(lintCatSignature('merged\n[砚砚/gpt-5.6-sol🐾]').signed, true);
  });

  test('整条消息就是一个契约签名 → signed', () => {
    assert.equal(lintCatSignature('[宪宪/claude-opus-4-8🐾]').signed, true);
  });

  // --- P1-3：strip matcher 容忍但契约不合规的形态 → NOT signed ---
  test('P1-3: pawed slashless [Spark🐾]（无模型型号）→ NOT signed', () => {
    assert.equal(lintCatSignature('done\n\n[Spark🐾]').signed, false);
  });

  test('P1-3: pawed slashless [烁烁🐾]（无模型型号）→ NOT signed', () => {
    assert.equal(lintCatSignature('x\n[烁烁🐾]').signed, false);
  });

  test('P1-3: legacy 无爪 slashed [砚砚/GPT-5.5]（缺 🐾）→ NOT signed', () => {
    assert.equal(lintCatSignature('merged\n[砚砚/GPT-5.5]').signed, false);
  });

  // --- walk 逻辑：跳过 trailing 空行 / 行内空白 / \r\n ---
  test('契约签名后有 trailing 空行 → 仍 signed（跳过空行）', () => {
    assert.equal(lintCatSignature('text\n[烁烁/Gemini-25🐾]\n\n  \n').signed, true);
  });

  test('契约签名行含前后空白 → signed，signatureLine 已 trim', () => {
    const r = lintCatSignature('text\n   [宪宪/Opus-46🐾]   ');
    assert.equal(r.signed, true);
    assert.equal(r.signatureLine, '[宪宪/Opus-46🐾]');
  });

  test('\\r\\n 换行 → 正确 walk', () => {
    assert.equal(lintCatSignature('line1\r\nline2\r\n[砚砚/Codex🐾]\r\n').signed, true);
  });

  // --- 反例：契约签名非末尾（其后还有内容行）---
  test('契约签名后还有内容行 → NOT signed（必须 trailing）', () => {
    const r = lintCatSignature('[宪宪/claude-opus-4-8🐾]\n\nPS: one more thing.');
    assert.equal(r.signed, false);
    assert.equal(r.signatureLine, null);
  });

  // --- 反例：完全没有签名（dev-7a882ba0 漏签类）---
  test('普通消息无签名 → not signed', () => {
    assert.equal(lintCatSignature('LGTM, merging now.').signed, false);
  });

  test('空串 → not signed', () => {
    const r = lintCatSignature('');
    assert.equal(r.signed, false);
    assert.equal(r.signatureLine, null);
  });

  test('纯空白 → not signed', () => {
    assert.equal(lintCatSignature('   \n\n  ').signed, false);
  });

  // --- 反例：非签名形态 ---
  test('正文 token [Phase B] → not signed', () => {
    assert.equal(lintCatSignature('Update:\n[Phase B]').signed, false);
  });

  test('括号文件路径 [packages/api/src/foo.ts] → not signed', () => {
    assert.equal(lintCatSignature('see\n[packages/api/src/foo.ts]').signed, false);
  });

  // sol R4 P1: model may be PROVIDER-QUALIFIED (contains '/'); first slash delimits.
  test('provider-qualified [金渐层/codex-for-me/gpt-5.4🐾]（opencode roster 实锤）→ signed', () => {
    const r = lintCatSignature('done\n[金渐层/codex-for-me/gpt-5.4🐾]');
    assert.equal(r.signed, true);
    assert.equal(r.signatureLine, '[金渐层/codex-for-me/gpt-5.4🐾]');
  });

  test('multi-segment model [a/b/c🐾] → signed（first slash 分隔，model=b/c）', () => {
    assert.equal(lintCatSignature('x\n[a/b/c🐾]').signed, true);
  });

  test('sol R4 P1: 空白 nickname [ /gpt-5.6-sol🐾] → not signed（trim 后非空必需）', () => {
    assert.equal(lintCatSignature('x\n[ /gpt-5.6-sol🐾]').signed, false);
  });

  test('sol R4 P1: 空白 model [砚砚/ 🐾] → not signed（trim 后非空必需）', () => {
    assert.equal(lintCatSignature('x\n[砚砚/ 🐾]').signed, false);
  });
});

describe('F257 #4 — signatureLintExtra (post-seam extra projection)', () => {
  test('契约签名消息 → { signatureLint: { signed: true } }', () => {
    assert.deepEqual(signatureLintExtra('done\n\n[宪宪/claude-opus-4-8🐾]'), {
      signatureLint: { signed: true },
    });
  });

  test('无签名 text 消息 → { signatureLint: { signed: false } }', () => {
    assert.deepEqual(signatureLintExtra('LGTM, merging now.'), {
      signatureLint: { signed: false },
    });
  });

  test('非契约签名 [Spark🐾] → { signatureLint: { signed: false } }', () => {
    assert.deepEqual(signatureLintExtra('done\n[Spark🐾]'), {
      signatureLint: { signed: false },
    });
  });

  test('blank/whitespace content → {} (pure-media exclusion, out of denominator)', () => {
    assert.deepEqual(signatureLintExtra(''), {});
    assert.deepEqual(signatureLintExtra('   \n\n  '), {});
  });
});
