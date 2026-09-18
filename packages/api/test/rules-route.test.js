import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const { isLegacySkillProjectPath, readL0Prompts, loadAvailableCatsForL0, readRulesPayload, rulesRoutes } = await import(
  '../dist/routes/rules.js'
);

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

  it('previews project-local plugin skill source from selected projectPath', async () => {
    const projectRoot = join(tmpdir(), `rules-plugin-preview-${process.pid}-${Date.now()}`);
    const pluginId = 'preview-plugin';
    const skillName = 'preview-skill';
    const skillsSource = join(projectRoot, 'plugins', pluginId, 'skills');
    const skillDir = join(skillsSource, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Project Plugin Preview\n');
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.cat-cafe', 'capabilities.json'),
      JSON.stringify(
        {
          version: 2,
          capabilities: [
            {
              id: skillName,
              type: 'skill',
              enabled: true,
              source: 'cat-cafe',
              pluginId,
              skillsSource: relative(projectRoot, skillsSource),
            },
          ],
        },
        null,
        2,
      ),
    );
    const app = Fastify();
    await app.register(rulesRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/rules/skill/${skillName}?projectPath=${encodeURIComponent(projectRoot)}`,
        headers: { 'x-cat-cafe-user': 'test-user' },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = res.json();
      assert.match(body.content, /Project Plugin Preview/);
      assert.equal(body.path, realpathSync(join(skillDir, 'SKILL.md')));
    } finally {
      await app.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('session hook pipeline source helper', () => {
  const root = findProjectRoot();

  it('hook pipeline README exists at expected path', () => {
    assert.ok(existsSync(join(root, 'assets', 'prompt-hooks', 'README.md')));
  });

  it('returns one source-of-truth directory without per-cat compilation', async () => {
    const result = await readL0Prompts(root);

    assert.ok(result.template.content.length > 0, 'template content non-empty');
    assert.equal(result.template.path, 'assets/prompt-hooks/README.md');
    assert.equal(result.template.exists, true);

    assert.deepEqual(result.compiledByCat, []);
    assert.equal(result.customization.templatePath, 'assets/prompt-hooks/README.md');
    assert.equal(result.customization.compileScript, '');
    assert.match(result.customization.verifyCommand, /isolated native-carrier invocation/);
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
    const isolatedRoot = join(tmpdir(), `cat-cafe-rules-l0-${process.pid}-${Date.now()}`);
    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    mkdirSync(isolatedRoot, { recursive: true });
    cpSync(join(root, 'cat-template.json'), join(isolatedRoot, 'cat-template.json'));
    process.env.CAT_TEMPLATE_PATH = join(isolatedRoot, 'cat-template.json');
    try {
      const cats = loadAvailableCatsForL0();
      assert.ok(Array.isArray(cats), 'returns an array');
      assert.ok(cats.length > 0, `must return ≥1 cat from template defaults; got ${cats.length}`);
      assert.ok(
        cats.every((c) => typeof c.catId === 'string' && typeof c.displayName === 'string'),
        'each entry has catId + displayName',
      );
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});

describe('rules consumption metadata (#749)', () => {
  const root = findProjectRoot();

  it('labels actual prompt vs reference documents in /api/rules payload', async () => {
    const result = await readRulesPayload(root);

    const sharedRules = result.sharedRules.find((f) => f.path === 'cat-cafe-skills/refs/shared-rules.md');
    assert.equal(sharedRules?.consumption.kind, 'actual-prompt');
    assert.match(sharedRules?.consumption.detail ?? '', /shared-rules\.md.*session hook pipeline/i);
    assert.ok(sharedRules?.consumption.consumers.includes('HookPipeline'));
    assert.ok(sharedRules?.consumption.consumers.includes('SystemPromptBuilder'));

    const sop = result.sharedRules.find((f) => f.path === 'docs/SOP.md');
    assert.equal(sop?.consumption.kind, 'reference');
    assert.match(sop?.consumption.detail ?? '', /not injected/i);

    const hookDirectory = result.l0Prompts.template;
    assert.equal(hookDirectory.consumption.kind, 'actual-prompt');
    assert.match(hookDirectory.consumption.detail, /assembled once by HookPipeline/);

    assert.deepEqual(result.l0Prompts.compiledByCat, []);

    const codexGuide = result.providerGuides.find((g) => g.provider === 'codex');
    assert.equal(codexGuide?.consumption.kind, 'harness-injected');
    assert.match(codexGuide?.consumption.detail ?? '', /Codex CLI/i);
  });
});
