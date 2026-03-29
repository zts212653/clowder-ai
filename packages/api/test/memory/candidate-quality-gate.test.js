import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Candidate quality gate', () => {
  let isImplementationNoise;
  let MAX_CANDIDATES_PER_SEGMENT;

  it('loads exports', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    isImplementationNoise = mod.isImplementationNoise;
    MAX_CANDIDATES_PER_SEGMENT = mod.MAX_CANDIDATES_PER_SEGMENT;
    assert.equal(typeof isImplementationNoise, 'function');
    assert.equal(MAX_CANDIDATES_PER_SEGMENT, 2);
  });

  // ── Reject: implementation noise ──────────────────────────────

  it('rejects code action titles (Chinese)', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(mod.isImplementationNoise('加了 mkdirSync 到 writeYaml 前面', '修复 ENOENT'));
    assert.ok(mod.isImplementationNoise('改了 regex 支持 !? 后缀', 'regex fix'));
    assert.ok(mod.isImplementationNoise('重写 JSON parser', '改为自然语言解析'));
    assert.ok(mod.isImplementationNoise('删了旧的 schema 验证', '简化代码'));
  });

  it('rejects code action titles (English)', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(mod.isImplementationNoise('Added mkdirSync before writeFileSync', 'fix ENOENT'));
    assert.ok(mod.isImplementationNoise('Replaced JSON schema with natural language parser', ''));
    assert.ok(mod.isImplementationNoise('Fixed regex to handle optional exclamation', ''));
    assert.ok(mod.isImplementationNoise('Removed old migration code', 'cleanup'));
  });

  it('rejects titles that are too short', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(mod.isImplementationNoise('fix', 'fix'));
    assert.ok(mod.isImplementationNoise('update', 'done'));
    assert.ok(mod.isImplementationNoise('小修', '小修'));
  });

  it('rejects candidates saturated with code artifacts', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(
      mod.isImplementationNoise(
        'submitCandidate pipeline with parser refactor',
        'JSON.parse schema endpoint migration handler',
      ),
    );
  });

  it('rejects real production garbage candidates (铲屎官 reported)', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    // These are the exact candidates from the screenshot that triggered the bug report
    assert.ok(mod.isImplementationNoise('submitCandidate 管道自动提取并推送到 Feed', '这是 Feed 自己的实现描述'));
    assert.ok(mod.isImplementationNoise('SummaryCompactionTask.ts JSON schema 验证改写', '代码重构细节'));
    assert.ok(mod.isImplementationNoise("'!'后缀 → 修复: regex加'!?'", '一个 regex fix'));
  });

  it('rejects titles containing file paths or class identifiers', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(mod.isImplementationNoise('MarkerQueue.ts 增加了 ensureDir 方法', '确保目录存在'));
    assert.ok(mod.isImplementationNoise('parseNaturalLanguageOutput 改成单段输出', '简化解析逻辑'));
  });

  // ── Accept: durable knowledge ─────────────────────────────────

  it('accepts genuine decisions', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(
      !mod.isImplementationNoise(
        'Knowledge Feed uses YAML files as truth source, not SQLite',
        'For git-trackability and human readability',
      ),
    );
    assert.ok(
      !mod.isImplementationNoise(
        'Entry point hierarchy follows usage frequency',
        'High-freq exposed, low-freq nested in menus',
      ),
    );
  });

  it('accepts genuine lessons', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(
      !mod.isImplementationNoise(
        'Fail-open catch blocks must log errors, not silently swallow',
        'Silent failures cause looks-OK-but-actually-empty bugs',
      ),
    );
    assert.ok(
      !mod.isImplementationNoise(
        'Independent sidecar services should not rely on runtime cwd for path resolution',
        'Can cause silent path misresolution across environments',
      ),
    );
  });

  it('accepts genuine methods', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(
      !mod.isImplementationNoise(
        'Let the model output natural language; program adds structural fields afterward',
        'Plays to each strengths: model for content, code for format',
      ),
    );
  });

  it('accepts PascalCase product/brand names as real knowledge (regression)', async () => {
    const mod = await import('../../dist/domains/memory/AbstractiveSummaryClient.js');
    assert.ok(
      !mod.isImplementationNoise(
        'OpenClaw inspired our gateway architecture',
        'We borrowed the product shape but not its sealing model',
      ),
    );
    assert.ok(
      !mod.isImplementationNoise(
        'GitHub Notifications is the interaction model for Knowledge Feed',
        'Single inbox with action-oriented grouping',
      ),
    );
  });
});
