import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { isLegacySkillProjectPath, readL0Prompts, loadAvailableCatsForL0 } = await import('../dist/routes/rules.js');

function findProjectRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

describe('rules route data sources', () => {
  const root = findProjectRoot();

  it('shared-rules.md exists at expected path', () => {
    assert.ok(existsSync(join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md')));
  });

  it('SOP.md exists at expected path', () => {
    assert.ok(existsSync(join(root, 'docs', 'SOP.md')));
  });

  it('provider guide files exist', () => {
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      assert.ok(existsSync(join(root, file)), `${file} should exist`);
    }
  });

  it('cat-cafe-skills directory has SKILL.md files', () => {
    const skillsDir = join(root, 'cat-cafe-skills');
    assert.ok(existsSync(skillsDir), 'cat-cafe-skills directory should exist');
    const qualityGateSkill = join(skillsDir, 'quality-gate', 'SKILL.md');
    assert.ok(existsSync(qualityGateSkill), 'quality-gate/SKILL.md should exist');
  });

  it('rejects path traversal in skill name', () => {
    assert.ok(!/^[a-z][a-z0-9-]*$/i.test('../etc'));
    assert.ok(!/^[a-z][a-z0-9-]*$/i.test('foo/bar'));
    assert.ok(!/^[a-z][a-z0-9-]*$/i.test('.hidden'));
    assert.ok(/^[a-z][a-z0-9-]*$/i.test('quality-gate'));
    assert.ok(/^[a-z][a-z0-9-]*$/i.test('tdd'));
  });

  it('keeps projectPath skill lookup inside legacy skill roots', () => {
    const roots = ['/home/tester', '/tmp', '/workspace', '/Volumes'];
    assert.equal(isLegacySkillProjectPath('/home/tester/project', roots), true);
    assert.equal(isLegacySkillProjectPath('/tmp/project', roots), true);
    assert.equal(isLegacySkillProjectPath('/workspace/project', roots), true);
    assert.equal(isLegacySkillProjectPath('/Volumes/project', roots), true);
    assert.equal(isLegacySkillProjectPath('/opt/private-project', roots), false);
    assert.equal(isLegacySkillProjectPath('/srv/private-project', roots), false);
  });
});

describe('readL0Prompts helper (F203 Phase F)', () => {
  const root = findProjectRoot();

  it('L0 template file exists at expected path', () => {
    assert.ok(existsSync(join(root, 'assets', 'system-prompts', 'system-prompt-l0.md')));
  });

  it('returns template + per-cat compiled + customization shape', async () => {
    const fakeCats = [
      { catId: 'opus-47', displayName: '布偶猫 Opus 4.7' },
      { catId: 'codex', displayName: '缅因猫 GPT-5.5(codex)' },
    ];
    const compileCalls = [];
    const fakeCompile = async ({ catId }) => {
      compileCalls.push(catId);
      return `COMPILED-L0-FOR-${catId}`;
    };
    const result = await readL0Prompts(root, { availableCats: fakeCats, compileL0: fakeCompile });

    assert.ok(result.template.content.length > 0, 'template content non-empty');
    assert.equal(result.template.path, 'assets/system-prompts/system-prompt-l0.md');
    assert.equal(result.template.exists, true);

    assert.equal(result.compiledByCat.length, 2);
    assert.equal(result.compiledByCat[0].catId, 'opus-47');
    assert.equal(result.compiledByCat[0].displayName, '布偶猫 Opus 4.7');
    assert.equal(result.compiledByCat[0].compiled, 'COMPILED-L0-FOR-opus-47');
    assert.equal(result.compiledByCat[0].error, null);
    assert.equal(result.compiledByCat[1].catId, 'codex');
    assert.equal(result.compiledByCat[1].compiled, 'COMPILED-L0-FOR-codex');

    assert.deepEqual(compileCalls.sort(), ['codex', 'opus-47'], 'compile called once per cat');

    assert.equal(result.customization.templatePath, 'assets/system-prompts/system-prompt-l0.md');
    assert.equal(result.customization.compileScript, 'scripts/compile-system-prompt-l0.mjs');
    assert.match(result.customization.verifyCommand, /pnpm gate.*restart/);
  });

  it('loadAvailableCatsForL0 propagates loadCatConfig errors instead of silent [] (cloud P2 R2)', () => {
    // Cloud round-2 P2 (PR #1717): try/catch swallowed ALL config errors →
    // malformed template/schema regression silently became 0 cats, masking
    // real config breakage. Now: only the genuinely-absent catalog is handled
    // internally by loadCatConfig (no error to swallow there); any real
    // loader exception MUST propagate so the operator sees 5xx + clear cause.
    const fakeLoader = () => {
      throw new Error('simulated schema validation failure');
    };
    assert.throws(
      () => loadAvailableCatsForL0(fakeLoader),
      /simulated schema validation failure/,
      'loader errors must propagate, not be swallowed to []',
    );
  });

  it('loadAvailableCatsForL0 returns non-empty cats even without local .cat-cafe/cat-catalog.json (cloud P1)', () => {
    // Cloud codex review P1 (PR #1717): hardcoding the catalog file path
    // silently returns [] when bootstrap-empty or file missing — skips
    // template defaults. The no-arg loadCatConfig() runtime path merges
    // template (base) + catalog (overlay), so even with no catalog the
    // template defaults populate the cat list (KD-13 / SystemPromptBuilder).
    const cats = loadAvailableCatsForL0();
    assert.ok(Array.isArray(cats), 'returns an array');
    assert.ok(cats.length > 0, `must return ≥1 cat from template defaults; got ${cats.length}`);
    assert.ok(
      cats.every((c) => typeof c.catId === 'string' && typeof c.displayName === 'string'),
      'each entry has catId + displayName',
    );
  });

  it('per-cat compile failure captured in error field, does not throw (砚砚 plan-review)', async () => {
    // read-only viewer 不该因为一只猫 compile 失败整页 5xx；
    // error 字段非空 = compile 失败语义（前端要显示「编译失败」而非「文件不存在」）
    const fakeCats = [
      { catId: 'good-cat', displayName: 'Good' },
      { catId: 'bad-cat', displayName: 'Bad' },
    ];
    const fakeCompile = async ({ catId }) => {
      if (catId === 'bad-cat') throw new Error('simulated compile failure');
      return `COMPILED-${catId}`;
    };
    const result = await readL0Prompts(root, { availableCats: fakeCats, compileL0: fakeCompile });

    assert.equal(result.compiledByCat[0].compiled, 'COMPILED-good-cat');
    assert.equal(result.compiledByCat[0].error, null);
    assert.equal(result.compiledByCat[1].compiled, '');
    assert.match(result.compiledByCat[1].error, /simulated compile failure/);
  });
});
