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

  it('projects the distinction between A2A routing and human progress from its source', () => {
    const l0 = compileGovernanceL0FromMarkdown(sharedRules);
    const progressBoundary = sharedRules.match(/人或队友发起任务，进度都对人可见/)?.[0];
    assert.ok(progressBoundary, 'the source must declare the human progress boundary');
    assert.ok(l0.includes(progressBoundary));
    assert.ok(l0.includes('先用本轮正文说明要做什么，再调用工具'));
    assert.ok(l0.includes('进度说明无需 @ 或唤醒队友'));
    assert.ok(l0.includes('不用工具计数代替说明'));
    const revised = sharedRules.replace(progressBoundary, 'SOURCE-PROGRESS-BOUNDARY');
    assert.ok(compileGovernanceL0FromMarkdown(revised).includes('SOURCE-PROGRESS-BOUNDARY'));
  });

  it('injects the source-owned end-of-turn human request rule without the disk-compression example', () => {
    const l0 = compileGovernanceL0FromMarkdown(sharedRules);
    assert.match(l0, /收尾仍需.+决定或操作/);
    assert.ok(l0.includes('先按决策漏斗判断能否自决'));
    assert.ok(l0.includes('今天不答会怎样'));
    assert.ok(l0.includes('FYI 不进待办'));
    assert.ok(!l0.includes('分批压缩旧档'));
  });

  it('keeps the human handoff rule when public branding changes its heading addressee', () => {
    for (const addressee of ['operator', 'co-creator']) {
      const branded = sharedRules.replace(/^### 收尾找[^\n]+$/m, `### 收尾找${addressee}`);
      const l0 = compileGovernanceL0FromMarkdown(branded);
      assert.ok(l0.includes('先按决策漏斗判断能否自决'));
      assert.ok(l0.includes('今天不答会怎样'));
      assert.ok(l0.includes('FYI 不进待办'));
      assert.ok(!l0.includes('分批压缩旧档'));
    }
    const missing = sharedRules.replace(/^### 收尾找[^\n]+$/m, '### REMOVED-HUMAN-HANDOFF');
    assert.throws(() => compileGovernanceL0FromMarkdown(missing), /missing.*收尾找/);
  });

  it('projects the meta method from its source section once, without copying adjacent detail', () => {
    const heading = '## 元方法（Meta Method）';
    const withoutMethod = sharedRules.replace(/^## 元方法（Meta Method）[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/m, '');
    const method = '- SOURCE-METHOD: 按结果选择方法。\n- SOURCE-BOUNDARY: 保留授权与安全边界。';
    const source = `${withoutMethod}\n${heading}\n\n${method}\n\n## 不进入 L0 的细节\n\nDETAIL-ONLY-METHOD\n`;
    const l0 = compileGovernanceL0FromMarkdown(source);

    assert.equal(l0.split(method).length - 1, 1);
    assert.ok(!l0.includes('DETAIL-ONLY-METHOD'));
    const changed = compileGovernanceL0FromMarkdown(source.replace('按结果选择方法', '修订后的源方法'));
    assert.ok(changed.includes('修订后的源方法'));
    assert.ok(!changed.includes('按结果选择方法'));
    assert.throws(() => compileGovernanceL0FromMarkdown(withoutMethod), /missing.*元方法/);
    assert.throws(() => compileGovernanceL0FromMarkdown(`${source}\n${heading}\n重复`), /duplicate.*元方法/);
    assert.throws(() => compileGovernanceL0FromMarkdown(source.replace(method, '')), /empty.*元方法/);
  });

  it('compiles the required governance anchors from shared-rules.md', () => {
    const l0 = compileGovernanceL0FromMarkdown(sharedRules);

    assert.match(l0, /^## 3\. 家规（shared-rules\.md）/);
    assert.ok(l0.includes('Rule 0'));
    for (const p of ['P1', 'P2', 'P3', 'P4', 'P5']) assert.ok(l0.includes(`**${p}**`), `missing ${p}`);
    for (const w of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']) {
      assert.ok(l0.includes(`**${w}**`), `missing ${w}`);
    }
    for (const word of [
      '脚手架',
      '星星罐子',
      '第一性原理',
      '数学之美',
      '补锅匠',
      '四象限',
      'unknown-first',
      '钛合金裤衩子',
      '钛合金内裤',
      '防弹内裤',
      '汉弗莱喵',
    ]) {
      assert.ok(l0.includes(word), `missing magic word ${word}`);
    }
    for (const retired of ['绕路了', '喵约', '下次一定', '我能猜出来', '碎片够了']) {
      assert.ok(!l0.includes(retired), `retired magic word leaked into L0: ${retired}`);
    }
    assert.ok(l0.includes('引用、复述、讨论词义不触发'));
    assert.ok(l0.includes('纠正后继续原任务，不默认整项停工'));
    assert.ok(l0.includes('hold_ball'));
    assert.ok(l0.includes('球权只有第一人称'));
    assert.ok(l0.includes('共享状态文件'));
    assert.ok(l0.includes('只在 main 改'));
    assert.ok(l0.includes('fallback 层数检测'));
    assert.ok(!l0.includes('创意-实现解耦'), 'retired Siamese restriction must not enter active L0');
    assert.ok(!l0.includes('Dry Run Gate'), 'retired signature gate must not enter active L0');
    // Decision funnel projection (four-cat discussion 2026-06-01)
    assert.ok(l0.includes('决策漏斗'), 'missing decision funnel section');
    assert.ok(l0.includes('能翻代码解决的不要问人'), 'missing self-resolve reflex');
    assert.ok(l0.includes('Decision Packet'), 'missing Decision Packet anchor');
    assert.ok(l0.includes('SOP 流程推进不是决策'), 'missing SOP execution anchor');
  });

  it('projects the source trigger paragraph and accepts a smaller word set without leaking detail tables', () => {
    const revised = sharedRules.replace(
      /## Magic Words[^\n]*\n[\s\S]*?(?=### 包装未做自检协议)/,
      [
        '## Magic Words（co-creator专用纠偏词）',
        '',
        '### 触发约定',
        '',
        'SOURCE-TRIGGER: 引用不触发；纠正后继续原任务。',
        '',
        '### 速查表（L0 生成源）',
        '',
        '| 纠偏词 | 含义 | 立即动作 |',
        '|---|---|---|',
        '| 「星星罐子」 | P0 不可逆风险 | 立即停止新增副作用 |',
        '| 「四象限／unknown-first」 | 过早收敛 | 验证关键未知 |',
        '',
        '### 含义与使用边界',
        '',
        'DETAIL-ONLY: 这里是完整解释，不进入 L0。',
        '',
      ].join('\n'),
    );
    const l0 = compileGovernanceL0FromMarkdown(revised);
    assert.ok(l0.includes('SOURCE-TRIGGER: 引用不触发；纠正后继续原任务。'));
    assert.ok(l0.includes('-「四象限／unknown-first」= 过早收敛 → 验证关键未知'));
    assert.ok(!l0.includes('DETAIL-ONLY'));
    assert.throws(
      () => compileGovernanceL0FromMarkdown(revised.replace(/^\| 「[^\n]+\n/gm, '')),
      /Magic Words.*empty|no Magic Words/,
    );
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
      'commit body',
      '只在 main 改',
      '结论必须基于多源证据',
      'hotfix PR 必须由非作者 review',
      '按风险默认只找一只',
      '同族也行',
      '不允许 self-merge',
      '同一文件',
      '新增 ≥3 层',
      // Decision funnel drift guards
      '能翻代码解决的不要问人',
      'SOP 流程推进不是决策',
    ]) {
      assert.ok(normalizedSource.includes(phrase), `source fixture missing guard phrase: ${phrase}`);
      assert.ok(normalizedL0.includes(phrase), `compiled governance L0 drifted from shared-rules phrase: ${phrase}`);
    }

    assert.doesNotMatch(normalizedL0, /跨族优先|必须跨族/);

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
    const sanitizedSharedRules = sharedRules.replace(
      '### 缅因猫 fallback 层数检测协议',
      '### Maine Coon fallback 层数检测协议',
    );

    const l0 = compileGovernanceL0FromMarkdown(sanitizedSharedRules);

    assert.ok(l0.includes('Maine Coon fallback 层数检测'));
    assert.ok(!l0.includes('创意-实现解耦'));
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
