import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadAllowlist, scanSkillSurfaceText } from './check-skill-first-party-surfaces.mjs';

const REL_PATH = 'cat-cafe-skills/workspace-navigator/SKILL.md';
const INBOUND_RUNBOOK_URL = new URL('../cat-cafe-skills/refs/opensource-ops-inbound-pr.md', import.meta.url);
const TECHNICAL_NARRATIVE_METHOD_URL = new URL(
  '../docs/study/2026-08-29-technical-narrative-proof-loop-meta-method.md',
  import.meta.url,
);

function scan(content, allowlist = []) {
  return scanSkillSurfaceText(content, REL_PATH, allowlist);
}

describe('check-skill-first-party-surfaces', () => {
  it('keeps routine harness validation claim-routed and single-owner', () => {
    const worktree = readFileSync(new URL('../cat-cafe-skills/worktree/SKILL.md', import.meta.url), 'utf8');
    const writingSkills = readFileSync(new URL('../cat-cafe-skills/writing-skills/SKILL.md', import.meta.url), 'utf8');
    const memorySearch = readFileSync(
      new URL('../cat-cafe-skills/memory-search-best-practices/SKILL.md', import.meta.url),
      'utf8',
    );
    const prSignals = readFileSync(new URL('../cat-cafe-skills/refs/pr-signals.md', import.meta.url), 'utf8');
    const cicdTracking = readFileSync(new URL('../cat-cafe-skills/refs/cicd-tracking.md', import.meta.url), 'utf8');

    for (const [name, content] of [
      ['worktree', worktree],
      ['writing-skills', writingSkills],
    ]) {
      assert.doesNotMatch(
        content,
        /(?:即使|哪怕|无论)[^。\n]{0,80}(?:必须|至少)[^。\n]{0,40}`?pnpm check`?/,
        `${name} must not turn the exhaustive pnpm check bundle into a routine receipt`,
      );
      assert.match(content, /targeted|定向/, `${name} must name the targeted default`);
      assert.match(content, /五轴|风险/, `${name} must reserve full-gate escalation for actual risk`);
    }

    assert.match(memorySearch, /单一 owner|单一负责人/);
    assert.match(memorySearch, /一次终局交付|统一收敛/);
    assert.match(memorySearch, /不得.*独立.*(?:feed|任务|交付)/);

    for (const [name, content] of [
      ['pr-signals', prSignals],
      ['cicd-tracking', cicdTracking],
    ]) {
      assert.match(content, /不把.*(?:operator|maintainer).*付费.*修账单.*关 workflow.*待办/, name);
      assert.match(content, /结束这条不可执行的 CI 等待并继续 merge-gate/, name);
      assert.doesNotMatch(content, /由 maintainer 主动处理账户条件/, name);
    }
  });

  it('reuses one completed full gate across an unrelated base-only rebase', () => {
    const mergeGate = readFileSync(new URL('../cat-cafe-skills/merge-gate/SKILL.md', import.meta.url), 'utf8');

    assert.match(mergeGate, /一次 full gate|full gate[^。\n]*一次/i);
    assert.match(mergeGate, /作者 patch[^。\n]*(?:不变|等价)/i);
    assert.match(mergeGate, /base[^。\n]*(?:无关|无关联)/i);
    assert.match(mergeGate, /禁止[^。\n]*(?:重跑|重新运行)[^。\n]*full gate/i);
  });

  it('routes belief-testing explainers through an optional falsifiable technical cutaway', () => {
    const conceptDemo = readFileSync(
      new URL('../cat-cafe-skills/concept-demo-design/SKILL.md', import.meta.url),
      'utf8',
    );
    const contractTemplate = readFileSync(
      new URL('../cat-cafe-skills/concept-demo-design/refs/demo-contract-template.md', import.meta.url),
      'utf8',
    );
    const cutaway = readFileSync(
      new URL('../cat-cafe-skills/concept-demo-design/refs/falsifiable-technical-cutaway.md', import.meta.url),
      'utf8',
    );
    const techWriting = readFileSync(new URL('../cat-cafe-skills/tech-writing/SKILL.md', import.meta.url), 'utf8');
    const method = existsSync(TECHNICAL_NARRATIVE_METHOD_URL)
      ? readFileSync(TECHNICAL_NARRATIVE_METHOD_URL, 'utf8')
      : null;
    const manifest = readFileSync(new URL('../cat-cafe-skills/manifest.yaml', import.meta.url), 'utf8');
    const capabilityTips = JSON.parse(
      readFileSync(new URL('../packages/web/src/lib/capability-tips.seed.json', import.meta.url), 'utf8'),
    );

    assert.match(conceptDemo, /可证伪技术剖面/u);
    assert.match(conceptDemo, /主张.*失效机制.*可操纵消融.*verdict.*claim ceiling/su);
    assert.match(conceptDemo, /只有[^。\n]*技术主张[^。\n]*才触发/u);
    assert.match(contractTemplate, /可证伪技术剖面 Claim Bench/u);
    for (const anchor of ['falsifiable claim', 'competing explanation', 'ablation', 'verdict', 'claim ceiling']) {
      assert.match(contractTemplate, new RegExp(anchor, 'u'));
    }
    for (const pressureCase of ['Standard', 'Boundary', 'Conflict']) {
      assert.match(cutaway, new RegExp(`### ${pressureCase}`, 'u'));
    }
    assert.match(techWriting, /7P × 5E/u);
    assert.match(techWriting, /Exists.*Effect.*Explain.*Extend.*Endure/su);
    assert.match(techWriting, /concept-demo-design/u);
    assert.match(techWriting, /故事负责[^。\n]*注意力[^。\n]*实验台负责[^。\n]*信任/u);
    if (method !== null) assert.match(method, /#2 · .*技术剖面/u);
    assert.match(manifest, /可证伪技术剖面/u);
    const cutawayTip = capabilityTips.find((tip) => tip.id === 'capability-tech-writing-cutaway');
    assert.equal(cutawayTip?.sourceRef?.path, 'cat-cafe-skills/tech-writing/SKILL.md');
    assert.equal(
      cutawayTip?.structureSource?.path,
      'cat-cafe-skills/concept-demo-design/refs/falsifiable-technical-cutaway.md',
    );
    assert.equal(cutawayTip?.structureSource?.anchor, 'Claim Bench 最小结构');
    assert.equal(cutawayTip?.body?.includes('技术主张'), true);
    assert.equal(cutawayTip?.action?.draftPrompt?.includes('技术竞争力'), true);
  });

  it(
    'keeps open-source intake gate claims aligned with the live package check surface',
    { skip: !existsSync(INBOUND_RUNBOOK_URL) && 'home-only maintainer runbook is absent from public export' },
    () => {
      const reference = readFileSync(INBOUND_RUNBOOK_URL, 'utf8');
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

      assert.match(reference, /`pnpm gate`/);
      assert.match(reference, /`pnpm check`/);
      assert.doesNotMatch(reference, /PARALLEL_CHECKS/);
      for (const sunsetAlias of ['check:settings-primitives', 'check:source-hygiene']) {
        assert.equal(pkg.scripts[sunsetAlias], undefined, `${sunsetAlias} is expected to remain sunset`);
        assert.doesNotMatch(
          reference,
          new RegExp(`\\b${sunsetAlias.replace(':', '\\:')}\\b`),
          `live skill reference must not claim ${sunsetAlias} runs in pnpm gate`,
        );
      }
    },
  );

  it('keeps writing-plans formatting steps executable and source-derived', () => {
    const skill = readFileSync(new URL('../cat-cafe-skills/writing-plans/SKILL.md', import.meta.url), 'utf8');

    assert.match(skill, /## Formatting Command Contract/);
    assert.match(skill, /`pnpm check:fix`/);
    assert.match(skill, /`pnpm biome format --write <files>`/);
    assert.match(skill, /`pnpm check`/);
    assert.match(skill, /先从当前仓库的 `package\.json`、CI 或现有脚本确认/);
    assert.match(skill, /禁止只写[“"](?:run formatting|格式化)[”"]/);
  });

  it('blocks raw workspace navigate curl guidance', () => {
    const hits = scan(`
Use this command:

\`\`\`bash
curl -X POST http://localhost:3004/api/workspace/navigate \\
  -H 'Content-Type: application/json' \\
  -d '{"worktreeId":"cat-cafe","path":"docs/foo.md","action":"open"}'
\`\`\`
`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 5);
  });

  it('blocks scheme-less localhost curl guidance', () => {
    const hits = scan(`
\`\`\`bash
curl -X POST localhost:3004/api/workspace/navigate \\
  -d '{"worktreeId":"cat-cafe","path":"docs/foo.md","action":"open"}'
\`\`\`
`);
    assert.equal(hits.length, 1);
  });

  it('blocks multiline preview auto-open curl guidance', () => {
    const hits = scan(`
\`\`\`bash
curl -sS -X POST \\
  "$CAT_CAFE_API_URL/api/preview/auto-open" \\
  -d '{"port":5102}'
\`\`\`
`);
    assert.equal(hits.length, 1);
  });

  it('allows typed MCP guidance', () => {
    const hits = scan(`
\`\`\`ts
await cat_cafe_workspace_navigate({ worktreeId: 'cat-cafe', path: 'docs/foo.md', action: 'open' });
\`\`\`
`);
    assert.deepEqual(hits, []);
  });

  it('allows generic localhost health probes', () => {
    const hits = scan(`
\`\`\`bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT
\`\`\`
`);
    assert.deepEqual(hits, []);
  });

  it('allows negative guidance that warns against raw curl', () => {
    const hits = scan('不要手写 `/api/preview/auto-open` 的 `curl`，主路径是 `cat_cafe_preview_open`。');
    assert.deepEqual(hits, []);
  });

  it('allows explicit instead-of-raw-curl guidance', () => {
    const hits = scan(
      'Use `cat_cafe_workspace_navigate` instead of raw curl to `localhost:3004/api/workspace/navigate`.',
    );
    assert.deepEqual(hits, []);
  });

  it('blocks positive fallback guidance that says to run raw curl instead', () => {
    const hits = scan(`
If the MCP tool is unavailable, run this instead:
curl -X POST localhost:3004/api/workspace/navigate \\
  -d '{"worktreeId":"cat-cafe","path":"docs/foo.md","action":"open"}'
`);
    assert.equal(hits.length, 1);
  });

  it('honors reviewed allowlist entries', () => {
    const hits = scan('curl -X POST http://localhost:3004/api/workspace/navigate', [
      { path: REL_PATH, pattern: 'http://localhost:3004/api/workspace/navigate', reason: 'fixture' },
    ]);
    assert.deepEqual(hits, []);
  });

  it('fails closed when allowlist is missing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'skill-surface-missing-allowlist-'));
    assert.throws(() => loadAllowlist(repo), /allowlist missing/i);
  });

  it('fails closed when allowlist entries are malformed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'skill-surface-malformed-allowlist-'));
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts/check-skill-first-party-surfaces.allowlist.json'),
      JSON.stringify({ allow: [{ path: REL_PATH, pattern: 'x' }] }),
    );
    assert.throws(() => loadAllowlist(repo), /missing non-empty reason/i);
  });
});
