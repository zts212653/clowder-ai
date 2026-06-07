import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { compileGovernanceL0FromMarkdown, loadCompiledGovernanceL0 } = await import(
  '../dist/domains/cats/services/context/governance-l0.js'
);

function findProjectRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function makeSharedRulesRoot(baseContent) {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-governance-l0-'));
  const refsDir = join(root, 'cat-cafe-skills', 'refs');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, 'shared-rules.md'), baseContent);
  return root;
}

describe('governance-l0 compiler (#747)', () => {
  const root = findProjectRoot();
  const sharedRules = readFileSync(join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md'), 'utf-8');

  it('compiles the required governance anchors from shared-rules.md', () => {
    const l0 = compileGovernanceL0FromMarkdown(sharedRules);

    assert.match(l0, /^## 3\. 家规（shared-rules\.md）/);
    assert.ok(l0.includes('Rule 0'));
    for (const p of ['P1', 'P2', 'P3', 'P4', 'P5']) assert.ok(l0.includes(`**${p}**`), `missing ${p}`);
    for (const w of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']) {
      assert.ok(l0.includes(`**${w}**`), `missing ${w}`);
    }
    for (const word of ['脚手架', '绕路了', '喵约', '星星罐子', '第一性原理', '数学之美', '下次一定']) {
      assert.ok(l0.includes(word), `missing magic word ${word}`);
    }
    assert.ok(l0.includes('hold_ball'));
    assert.ok(l0.includes('球权只有第一人称'));
    assert.ok(l0.includes('共享状态文件'));
    assert.ok(l0.includes('只在 main 改'));
    assert.ok(l0.includes('fallback 层数检测'));
    assert.ok(l0.includes('创意-实现解耦'));
    // Decision funnel projection (four-cat discussion 2026-06-01)
    assert.ok(l0.includes('决策漏斗'), 'missing decision funnel section');
    assert.ok(l0.includes('能翻代码解决的不要问人'), 'missing self-resolve reflex');
    assert.ok(l0.includes('Decision Packet'), 'missing Decision Packet anchor');
    assert.ok(l0.includes('SOP 流程推进不是决策'), 'missing SOP execution anchor');
  });

  it('guards hard-projected compact phrases against shared-rules drift (opus review P2)', () => {
    const l0 = compileGovernanceL0FromMarkdown(sharedRules);
    const normalizedSource = sharedRules.replaceAll('**', '').replace(/\s+/g, ' ');
    const normalizedL0 = l0.replaceAll('**', '').replace(/\s+/g, ' ');

    for (const phrase of [
      '不是外包工具',
      '证据',
      '适用性论证',
      '替代方案',
      '我现在在做什么',
      '我的信息源可靠吗',
      '方案感觉笨重',
      'commit body',
      '只在 main 改',
      '结论必须基于多源证据',
      'hotfix PR 必须跨族',
      '不允许 self-merge',
      '同一文件',
      '新增 ≥3 层',
      '发现问题 ≠ 动手实现',
      // Decision funnel drift guards
      '能翻代码解决的不要问人',
      'SOP 流程推进不是决策',
    ]) {
      assert.ok(normalizedSource.includes(phrase), `source fixture missing guard phrase: ${phrase}`);
      assert.ok(normalizedL0.includes(phrase), `compiled governance L0 drifted from shared-rules phrase: ${phrase}`);
    }

    // Decision Packet is hardcoded output (not projected from shared-rules source),
    // guard it independently (sonnet review W2)
    assert.ok(normalizedL0.includes('Decision Packet'), 'compiled L0 missing hardcoded Decision Packet anchor');
  });

  it('fails closed when numbered P/W headings are duplicated or missing (cloud P2)', () => {
    const duplicatePrinciple = sharedRules.replace(/^### P3\./m, '### P1.');
    assert.throws(
      () => compileGovernanceL0FromMarkdown(duplicatePrinciple),
      /duplicate P heading P1|missing P heading P3/,
    );

    const duplicateWorldview = sharedRules.replace(/^### W5\./m, '### W2.');
    assert.throws(
      () => compileGovernanceL0FromMarkdown(duplicateWorldview),
      /duplicate W heading W2|missing W heading W5/,
    );
  });

  it('fails closed when decision funnel §17 is removed from shared-rules', () => {
    const withoutFunnel = sharedRules.replace('## 17. 决策漏斗', '## 17. REMOVED');
    assert.throws(() => compileGovernanceL0FromMarkdown(withoutFunnel), /决策漏斗/);
  });

  it('accepts public-sanitized family labels in governance protocol headings (outbound sync)', () => {
    const sanitizedSharedRules = sharedRules
      .replace('### 缅因猫 fallback 层数检测协议', '### Maine Coon fallback 层数检测协议')
      .replace('### 暹罗猫 创意-实现解耦协议', '### Siamese 创意-实现解耦协议');

    const l0 = compileGovernanceL0FromMarkdown(sanitizedSharedRules);

    assert.ok(l0.includes('Maine Coon fallback 层数检测'));
    assert.ok(l0.includes('Siamese 创意-实现解耦'));
  });

  it('loads base shared-rules.md and returns source metadata', async () => {
    const loaded = await loadCompiledGovernanceL0(root);

    assert.equal(loaded.source, 'base');
    assert.equal(loaded.generatedFrom, 'cat-cafe-skills/refs/shared-rules.md');
    assert.equal(loaded.overlayPath, null);
    assert.equal(loaded.sourcePath, join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md'));
    assert.ok(loaded.content.includes('Rule 0'));
  });

  it('appends shared-rules.local.md after the compiled base digest', async () => {
    const tempRoot = makeSharedRulesRoot(sharedRules);
    const localPath = join(tempRoot, 'cat-cafe-skills', 'refs', 'shared-rules.local.md');
    writeFileSync(localPath, 'LOCAL-L0-APPEND-MARKER');

    const loaded = await loadCompiledGovernanceL0(tempRoot);

    assert.equal(loaded.source, 'local');
    assert.equal(loaded.overlayPath, localPath);
    assert.ok(loaded.content.includes('Rule 0'));
    assert.ok(loaded.content.includes('LOCAL-L0-APPEND-MARKER'));

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses shared-rules.local-override.md as the final compiled governance block', async () => {
    const tempRoot = makeSharedRulesRoot(sharedRules);
    const overridePath = join(tempRoot, 'cat-cafe-skills', 'refs', 'shared-rules.local-override.md');
    writeFileSync(overridePath, 'OVERRIDE-L0-ONLY');

    const loaded = await loadCompiledGovernanceL0(tempRoot);

    assert.equal(loaded.source, 'override');
    assert.equal(loaded.overlayPath, overridePath);
    assert.equal(loaded.content, 'OVERRIDE-L0-ONLY');

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
