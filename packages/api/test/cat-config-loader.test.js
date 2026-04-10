import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const {
  loadCatConfig,
  getDefaultVariant,
  toFlatConfigs,
  toAllCatConfigs,
  findBreedByMention,
  isSessionChainEnabled,
  getMissionHubSelfClaimScope,
  getDefaultCatId,
  buildCatIdToBreedIndex,
  getCatEffort,
  _resetCachedConfig,
} = await import('../dist/config/cat-config-loader.js');

/** Create a temp JSON file with given content, return path */
function writeTempConfig(data) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-template-'));
  const path = join(dir, 'cat-template.json');
  writeFileSync(path, JSON.stringify(data));
  return path;
}

/** Minimal valid config for testing */
function validConfig() {
  return {
    version: 1,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            clientId: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: '温柔',
          },
        ],
      },
    ],
  };
}

describe('cat-config-loader', () => {
  describe('loadCatConfig', () => {
    it('loads valid JSON successfully', () => {
      const path = writeTempConfig(validConfig());
      const config = loadCatConfig(path);
      assert.equal(config.version, 1);
      assert.equal(config.breeds.length, 1);
      assert.equal(config.breeds[0].id, 'ragdoll');
    });

    it('loads default project cat-template.json when no path/env provided', () => {
      const saved = process.env.CAT_TEMPLATE_PATH;
      delete process.env.CAT_TEMPLATE_PATH;
      try {
        const config = loadCatConfig();
        // F032: version can be 1 or 2 now
        assert.ok(config.version === 1 || config.version === 2);
        assert.ok(config.breeds.length >= 1);
      } finally {
        if (saved === undefined) {
          delete process.env.CAT_TEMPLATE_PATH;
        } else {
          process.env.CAT_TEMPLATE_PATH = saved;
        }
      }
    });

    it('prefers .cat-cafe/cat-catalog.json over cat-template.json for default loads', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'cat-template-project-'));
      const templatePath = join(projectDir, 'cat-template.json');
      writeFileSync(templatePath, JSON.stringify(validConfig()));
      const runtimeDir = join(projectDir, '.cat-cafe');
      mkdirSync(runtimeDir, { recursive: true });
      const runtimeConfig = validConfig();
      runtimeConfig.breeds[0].displayName = '运行时布偶猫';
      writeFileSync(join(runtimeDir, 'cat-catalog.json'), JSON.stringify(runtimeConfig));

      const saved = process.env.CAT_TEMPLATE_PATH;
      process.env.CAT_TEMPLATE_PATH = templatePath;
      try {
        const config = loadCatConfig();
        assert.equal(config.breeds[0].displayName, '运行时布偶猫');
      } finally {
        if (saved === undefined) {
          delete process.env.CAT_TEMPLATE_PATH;
        } else {
          process.env.CAT_TEMPLATE_PATH = saved;
        }
      }
    });

    it('deep-merges catalog overlay onto config base (preserves base-only fields)', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'cat-merge-project-'));
      const templatePath = join(projectDir, 'cat-template.json');

      // Base config: breed has teamStrengths and caution (fields catalog might not have)
      const base = validConfig();
      base.breeds[0].teamStrengths = 'base-only-strength';
      base.breeds[0].caution = 'base-only-caution';
      writeFileSync(templatePath, JSON.stringify(base));
      writeFileSync(join(projectDir, 'cat-config.json'), JSON.stringify(base));

      // Catalog: same breed with different displayName, but missing teamStrengths/caution
      const runtimeDir = join(projectDir, '.cat-cafe');
      mkdirSync(runtimeDir, { recursive: true });
      const catalog = validConfig();
      catalog.breeds[0].displayName = '运行时布偶猫';
      delete catalog.breeds[0].teamStrengths;
      delete catalog.breeds[0].caution;
      writeFileSync(join(runtimeDir, 'cat-catalog.json'), JSON.stringify(catalog));

      const saved = process.env.CAT_TEMPLATE_PATH;
      process.env.CAT_TEMPLATE_PATH = templatePath;
      try {
        const config = loadCatConfig();
        // Catalog override: displayName comes from catalog
        assert.equal(config.breeds[0].displayName, '运行时布偶猫', 'catalog displayName overrides base');
        // Base preservation: fields absent from catalog are preserved from base
        assert.equal(
          config.breeds[0].teamStrengths,
          'base-only-strength',
          'base breed field preserved when catalog lacks it',
        );
        assert.equal(config.breeds[0].caution, 'base-only-caution', 'base caution preserved when catalog lacks it');
      } finally {
        if (saved === undefined) {
          delete process.env.CAT_TEMPLATE_PATH;
        } else {
          process.env.CAT_TEMPLATE_PATH = saved;
        }
      }
    });

    it('replaces cli object when catalog switches provider so stale effort/defaultArgs do not leak from base', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'cat-cli-merge-project-'));
      const templatePath = join(projectDir, 'cat-template.json');

      const base = validConfig();
      base.breeds[0].variants[0].cli = {
        command: 'claude',
        outputFormat: 'stream-json',
        defaultArgs: ['--output-format', 'stream-json'],
        effort: 'max',
      };
      writeFileSync(templatePath, JSON.stringify(base));
      writeFileSync(join(projectDir, 'cat-config.json'), JSON.stringify(base));

      const runtimeDir = join(projectDir, '.cat-cafe');
      mkdirSync(runtimeDir, { recursive: true });
      const catalog = validConfig();
      catalog.breeds[0].variants[0].provider = 'openai';
      catalog.breeds[0].variants[0].defaultModel = 'gpt-5.4';
      catalog.breeds[0].variants[0].cli = {
        command: 'codex',
        outputFormat: 'json',
      };
      writeFileSync(join(runtimeDir, 'cat-catalog.json'), JSON.stringify(catalog));

      const saved = process.env.CAT_TEMPLATE_PATH;
      process.env.CAT_TEMPLATE_PATH = templatePath;
      try {
        const config = loadCatConfig();
        const variant = config.breeds[0].variants[0];
        assert.equal(variant.provider, 'openai');
        assert.deepEqual(variant.cli, {
          command: 'codex',
          outputFormat: 'json',
        });
        assert.equal('effort' in variant.cli, false, 'base cli.effort must not leak across provider switch');
        assert.equal('defaultArgs' in variant.cli, false, 'base cli.defaultArgs must not leak across provider switch');
      } finally {
        if (saved === undefined) {
          delete process.env.CAT_TEMPLATE_PATH;
        } else {
          process.env.CAT_TEMPLATE_PATH = saved;
        }
      }
    });

    it('replaces cli object when catalog switches provider from openai back to anthropic', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'cat-cli-reverse-merge-project-'));
      const templatePath = join(projectDir, 'cat-template.json');

      const base = validConfig();
      base.breeds[0].variants[0].provider = 'openai';
      base.breeds[0].variants[0].defaultModel = 'gpt-5.4';
      base.breeds[0].variants[0].cli = {
        command: 'codex',
        outputFormat: 'json',
        defaultArgs: ['exec', '--json'],
        effort: 'xhigh',
      };
      writeFileSync(templatePath, JSON.stringify(base));
      writeFileSync(join(projectDir, 'cat-config.json'), JSON.stringify(base));

      const runtimeDir = join(projectDir, '.cat-cafe');
      mkdirSync(runtimeDir, { recursive: true });
      const catalog = validConfig();
      catalog.breeds[0].variants[0].provider = 'anthropic';
      catalog.breeds[0].variants[0].defaultModel = 'claude-opus-4-1';
      catalog.breeds[0].variants[0].cli = {
        command: 'claude',
        outputFormat: 'stream-json',
      };
      writeFileSync(join(runtimeDir, 'cat-catalog.json'), JSON.stringify(catalog));

      const saved = process.env.CAT_TEMPLATE_PATH;
      process.env.CAT_TEMPLATE_PATH = templatePath;
      try {
        const config = loadCatConfig();
        const variant = config.breeds[0].variants[0];
        // F340: catalog's provider='anthropic' is kept (matches clientId, but retained to
        // prevent template's stale provider='openai' from leaking through the merge).
        assert.equal(variant.clientId, 'anthropic');
        assert.equal(variant.provider, 'anthropic', 'catalog provider must override template provider');
        assert.deepEqual(variant.cli, {
          command: 'claude',
          outputFormat: 'stream-json',
        });
        assert.equal('effort' in variant.cli, false, 'base cli.effort must not leak back to anthropic');
        assert.equal('defaultArgs' in variant.cli, false, 'base cli.defaultArgs must not leak back to anthropic');
      } finally {
        if (saved === undefined) {
          delete process.env.CAT_TEMPLATE_PATH;
        } else {
          process.env.CAT_TEMPLATE_PATH = saved;
        }
      }
    });

    it('rejects invalid JSON (missing required field)', () => {
      const bad = validConfig();
      delete bad.breeds[0].roleDescription;
      const path = writeTempConfig(bad);
      assert.throws(() => loadCatConfig(path), /Invalid cat config/);
    });

    it('rejects wrong version', () => {
      const bad = { ...validConfig(), version: 2 };
      const path = writeTempConfig(bad);
      assert.throws(() => loadCatConfig(path), /Invalid cat config/);
    });

    it('throws clear error when file not found', () => {
      assert.throws(() => loadCatConfig('/nonexistent/cat-template.json'), /Failed to read cat config/);
    });

    it('rejects empty variants array', () => {
      const bad = validConfig();
      bad.breeds[0].variants = [];
      const path = writeTempConfig(bad);
      assert.throws(() => loadCatConfig(path), /Invalid cat config/);
    });

    it('rejects invalid defaultVariantId reference', () => {
      const bad = validConfig();
      bad.breeds[0].defaultVariantId = 'nonexistent-variant';
      const path = writeTempConfig(bad);
      assert.throws(() => loadCatConfig(path), /defaultVariantId.*not found/);
    });

    it('rejects invalid provider', () => {
      const bad = validConfig();
      bad.breeds[0].variants[0].clientId = 'invalid-provider';
      const path = writeTempConfig(bad);
      assert.throws(() => loadCatConfig(path), /Invalid cat config/);
    });

    it('accepts dare provider (F050)', () => {
      const config = validConfig();
      config.breeds.push({
        id: 'dare-test',
        catId: 'dare',
        name: '狸花猫',
        displayName: '狸花猫',
        avatar: '/avatars/dare.png',
        color: { primary: '#D4A76A', secondary: '#F5EBD7' },
        mentionPatterns: ['@dare'],
        roleDescription: '确定性执行与审计引擎',
        defaultVariantId: 'dare-default',
        variants: [
          {
            id: 'dare-default',
            clientId: 'dare',
            defaultModel: 'zhipu/glm-4.7',
            mcpSupport: false,
            cli: { command: 'python', outputFormat: 'headless-json' },
          },
        ],
      });
      const path = writeTempConfig(config);
      const loaded = loadCatConfig(path);
      const cats = toAllCatConfigs(loaded);
      assert.ok(cats.dare);
      assert.strictEqual(cats.dare.clientId, 'dare');
    });

    it('accepts arbitrary catId (F32-a: any non-empty string is valid)', () => {
      // F32-a: catId is no longer restricted to opus/codex/gemini
      const custom = validConfig();
      custom.breeds[0].catId = 'foobar';
      custom.breeds[0].mentionPatterns = ['@foobar', '@布偶猫'];
      const path = writeTempConfig(custom);
      const config = loadCatConfig(path);
      assert.equal(config.breeds[0].catId, 'foobar');
    });
  });

  describe('getDefaultVariant', () => {
    it('returns the default variant', () => {
      const path = writeTempConfig(validConfig());
      const config = loadCatConfig(path);
      const variant = getDefaultVariant(config.breeds[0]);
      assert.equal(variant.id, 'opus-default');
      assert.equal(variant.clientId, 'anthropic');
    });
  });

  describe('toFlatConfigs', () => {
    it('produces Record matching CatConfig shape', () => {
      const path = writeTempConfig(validConfig());
      const config = loadCatConfig(path);
      const flat = toFlatConfigs(config);

      assert.ok(flat.opus);
      assert.equal(flat.opus.displayName, '布偶猫');
      assert.equal(flat.opus.clientId, 'anthropic');
      assert.equal(flat.opus.mcpSupport, true);
      assert.deepEqual(flat.opus.mentionPatterns, ['@opus', '@布偶猫']);
      assert.equal(flat.opus.personality, '温柔');
    });

    it('handles multiple breeds', () => {
      const cfg = validConfig();
      cfg.breeds.push({
        id: 'maine-coon',
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
        mentionPatterns: ['@codex', '@缅因猫'],
        roleDescription: '代码审查专家',
        defaultVariantId: 'codex-default',
        variants: [
          {
            id: 'codex-default',
            clientId: 'openai',
            defaultModel: 'codex',
            mcpSupport: false,
            cli: { command: 'codex', outputFormat: 'json' },
            personality: '严谨认真',
          },
        ],
      });
      const path = writeTempConfig(cfg);
      const config = loadCatConfig(path);
      const flat = toFlatConfigs(config);

      assert.ok(flat.opus);
      assert.ok(flat.codex);
      assert.equal(flat.codex.clientId, 'openai');
    });
  });

  describe('findBreedByMention', () => {
    it('finds breed by mention pattern', () => {
      const path = writeTempConfig(validConfig());
      const config = loadCatConfig(path);
      const result = findBreedByMention(config, '你好 @布偶猫 帮我看看');
      assert.ok(result);
      assert.equal(result.breed.id, 'ragdoll');
    });

    it('is case-insensitive', () => {
      const path = writeTempConfig(validConfig());
      const config = loadCatConfig(path);
      const result = findBreedByMention(config, 'Hello @OPUS');
      assert.ok(result);
      assert.equal(result.breed.id, 'ragdoll');
    });

    it('returns undefined when no match', () => {
      const path = writeTempConfig(validConfig());
      const config = loadCatConfig(path);
      const result = findBreedByMention(config, '你好世界');
      assert.equal(result, undefined);
    });

    it('longest-match-first: variant pattern wins over breed prefix (R28 regression)', () => {
      // @布偶45 must match opus-45 variant, not breed-level @布偶
      const cfg = multiVariantConfig();
      cfg.breeds[0].variants[1].mentionPatterns = ['@opus-45', '@布偶45'];
      cfg.breeds[0].mentionPatterns = ['@opus', '@布偶猫', '@布偶'];
      const config2 = loadCatConfig(writeTempConfig(cfg));
      const result = findBreedByMention(config2, '@布偶45 帮忙');
      assert.ok(result);
      assert.equal(String(result.catId), 'opus-45');
    });

    it('longest-match-first: project config @布偶sonnet resolves to sonnet', () => {
      const config = loadCatConfig();
      const result = findBreedByMention(config, '@布偶sonnet 帮忙');
      assert.ok(result);
      assert.equal(String(result.catId), 'sonnet');
    });

    it('breed-level short pattern still works when no prefix collision', () => {
      const config = loadCatConfig();
      const result = findBreedByMention(config, '@布偶 帮忙');
      assert.ok(result);
      assert.equal(String(result.catId), 'opus');
    });
  });

  describe('isSessionChainEnabled', () => {
    it('returns true by default (no features field)', () => {
      const config = loadCatConfig(writeTempConfig(validConfig()));
      assert.equal(isSessionChainEnabled('opus', config), true);
    });

    it('returns true when features.sessionChain is true', () => {
      const cfg = validConfig();
      cfg.breeds[0].features = { sessionChain: true };
      const config = loadCatConfig(writeTempConfig(cfg));
      assert.equal(isSessionChainEnabled('opus', config), true);
    });

    it('returns false when features.sessionChain is explicitly false', () => {
      const cfg = validConfig();
      cfg.breeds[0].features = { sessionChain: false };
      const config = loadCatConfig(writeTempConfig(cfg));
      assert.equal(isSessionChainEnabled('opus', config), false);
    });

    it('returns true for unknown catId (not in config)', () => {
      const config = loadCatConfig(writeTempConfig(validConfig()));
      assert.equal(isSessionChainEnabled('unknown-cat', config), true);
    });

    it('prefers variant.sessionChain override over breed-level setting', () => {
      const cfg = validConfig();
      cfg.breeds[0].features = { sessionChain: true };
      cfg.breeds[0].variants.push({
        id: 'opus-sonnet',
        catId: 'opus-sonnet',
        clientId: 'anthropic',
        defaultModel: 'claude-sonnet-4-5-20250929',
        mcpSupport: true,
        cli: { command: 'claude', outputFormat: 'stream-json' },
        sessionChain: false,
      });
      const config = loadCatConfig(writeTempConfig(cfg));
      assert.equal(isSessionChainEnabled('opus', config), true);
      assert.equal(isSessionChainEnabled('opus-sonnet', config), false);
    });

    it('F053: loads project config for gemini (sessionChain: true after parity fix)', () => {
      // Uses the actual project cat-config.json
      const config = loadCatConfig();
      assert.equal(isSessionChainEnabled('gemini', config), true);
      assert.equal(isSessionChainEnabled('opus', config), true);
      assert.equal(isSessionChainEnabled('codex', config), true);
    });

    it('accepts features with empty object (all defaults)', () => {
      const cfg = validConfig();
      cfg.breeds[0].features = {};
      const config = loadCatConfig(writeTempConfig(cfg));
      assert.equal(isSessionChainEnabled('opus', config), true);
    });

    it('Cloud P1: gracefully returns true when config file is missing (no throw)', () => {
      const saved = process.env.CAT_TEMPLATE_PATH;
      process.env.CAT_TEMPLATE_PATH = '/tmp/nonexistent-cat-template-12345.json';
      _resetCachedConfig();
      try {
        // Should NOT throw — should fallback to default (true)
        const result = isSessionChainEnabled('codex');
        assert.equal(result, true, 'should return true (default) when config is unreadable');
      } finally {
        if (saved === undefined) {
          delete process.env.CAT_TEMPLATE_PATH;
        } else {
          process.env.CAT_TEMPLATE_PATH = saved;
        }
        _resetCachedConfig();
      }
    });
  });

  describe('getMissionHubSelfClaimScope', () => {
    it('returns disabled by default when missionHub feature is not configured', () => {
      const config = loadCatConfig(writeTempConfig(validConfig()));
      assert.equal(getMissionHubSelfClaimScope('opus', config), 'disabled');
    });

    it('reads configured missionHub self-claim scope from breed features', () => {
      const cfg = validConfig();
      cfg.breeds[0].features = {
        missionHub: {
          selfClaimScope: 'global',
        },
      };
      const config = loadCatConfig(writeTempConfig(cfg));
      assert.equal(getMissionHubSelfClaimScope('opus', config), 'global');
    });
  });
});

// ── F32-b Multi-Variant Tests ──────────────────────────────────────────

/** Config with multiple variants per breed */
function multiVariantConfig() {
  return {
    version: 1,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫', '@布偶'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            clientId: 'anthropic',
            defaultModel: 'claude-opus-4-6',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: '温柔',
          },
          {
            id: 'opus-45',
            catId: 'opus-45',
            displayName: '布偶猫 4.5',
            mentionPatterns: ['@opus-45', '@布偶猫4.5'],
            clientId: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
            personality: '快速高效',
          },
        ],
      },
      {
        id: 'siamese',
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        avatar: '/avatars/gemini.png',
        color: { primary: '#D4A574', secondary: '#F5E6D3' },
        mentionPatterns: ['@gemini', '@暹罗猫'],
        roleDescription: '视觉设计',
        defaultVariantId: 'gemini-default',
        features: { sessionChain: false },
        variants: [
          {
            id: 'gemini-default',
            clientId: 'google',
            defaultModel: 'gemini-2.5-pro',
            mcpSupport: false,
            cli: { command: 'gemini', outputFormat: 'stream-json' },
            personality: '创意',
          },
        ],
      },
    ],
  };
}

describe('F32-b: toAllCatConfigs (multi-variant)', () => {
  it('expands all variants as independent cats', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.ok(all.opus, 'default variant registered as opus');
    assert.ok(all['opus-45'], 'non-default variant registered as opus-45');
    assert.ok(all.gemini, 'second breed registered');
    assert.equal(Object.keys(all).length, 3);
  });

  it('default variant inherits breed mentionPatterns', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.deepEqual(all.opus.mentionPatterns, ['@opus', '@布偶猫', '@布偶']);
  });

  it('non-default variant uses its own mentionPatterns (not breed)', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.deepEqual(all['opus-45'].mentionPatterns, ['@opus-45', '@布偶猫4.5']);
  });

  it('non-default variant with no mentionPatterns gets @catId fallback pattern', () => {
    const cfg = multiVariantConfig();
    // Add a variant without mentionPatterns and without catId override
    cfg.breeds[0].variants.push({
      id: 'opus-haiku',
      catId: 'opus-haiku',
      clientId: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      mcpSupport: false,
      cli: { command: 'claude', outputFormat: 'stream-json' },
      personality: '简洁',
    });
    const config = loadCatConfig(writeTempConfig(cfg));
    const all = toAllCatConfigs(config);
    assert.deepEqual(all['opus-haiku'].mentionPatterns, ['@opus-haiku']);
  });

  it('non-default variant with explicit empty mentionPatterns still gets @catId fallback', () => {
    const cfg = multiVariantConfig();
    cfg.breeds[0].variants.push({
      id: 'opus-haiku-empty',
      catId: 'opus-haiku-empty',
      mentionPatterns: [],
      clientId: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      mcpSupport: false,
      cli: { command: 'claude', outputFormat: 'stream-json' },
      personality: '简洁',
    });
    const config = loadCatConfig(writeTempConfig(cfg));
    const all = toAllCatConfigs(config);
    assert.deepEqual(all['opus-haiku-empty'].mentionPatterns, ['@opus-haiku-empty']);
  });

  it('variant overrides displayName', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.equal(all.opus.displayName, '布偶猫');
    assert.equal(all['opus-45'].displayName, '布偶猫 4.5');
  });

  it('variants without avatar/color inherit breed-level values', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    // opus-45 has no avatar/color override → inherits breed
    assert.equal(all.opus.avatar, all['opus-45'].avatar);
    assert.deepEqual(all.opus.color, all['opus-45'].color);
  });

  it('sets breedId on all variants', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.equal(all.opus.breedId, 'ragdoll');
    assert.equal(all['opus-45'].breedId, 'ragdoll');
    assert.equal(all.gemini.breedId, 'siamese');
  });

  it('throws on duplicate catId', () => {
    const cfg = multiVariantConfig();
    // Make second variant use same catId as default (no catId override → inherits breed)
    delete cfg.breeds[0].variants[1].catId;
    cfg.breeds[0].variants[1].mentionPatterns = ['@opus', '@布偶猫4.5'];
    assert.throws(() => toAllCatConfigs(loadCatConfig(writeTempConfig(cfg))), /Duplicate catId "opus"/);
  });

  it('preserves variant cli config in flattened output', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.deepEqual(all.opus.cli, { command: 'claude', outputFormat: 'stream-json' });
    assert.deepEqual(all['opus-45'].cli, { command: 'claude', outputFormat: 'stream-json' });
    assert.deepEqual(all.gemini.cli, { command: 'gemini', outputFormat: 'stream-json' });
  });

  it('toFlatConfigs is an alias for toAllCatConfigs', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    const flat = toFlatConfigs(config);
    assert.deepEqual(all, flat);
  });
});

describe('F32-b: buildCatIdToBreedIndex', () => {
  it('maps variant catIds to parent breed', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const index = buildCatIdToBreedIndex(config);
    assert.equal(index.get('opus').id, 'ragdoll');
    assert.equal(index.get('opus-45').id, 'ragdoll');
    assert.equal(index.get('gemini').id, 'siamese');
  });
});

describe('F32-b: isSessionChainEnabled (variant resolution)', () => {
  it('variant catId resolves to parent breed features', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    // opus-45 belongs to ragdoll → no features.sessionChain → true
    assert.equal(isSessionChainEnabled('opus-45', config), true);
    // gemini belongs to siamese → sessionChain: false
    assert.equal(isSessionChainEnabled('gemini', config), false);
  });
});

describe('F32-b: getDefaultCatId', () => {
  it('returns first breed default variant catId', () => {
    const saved = process.env.CAT_TEMPLATE_PATH;
    const path = writeTempConfig(multiVariantConfig());
    process.env.CAT_TEMPLATE_PATH = path;
    _resetCachedConfig();
    try {
      const id = getDefaultCatId();
      assert.equal(id, 'opus');
    } finally {
      if (saved === undefined) {
        delete process.env.CAT_TEMPLATE_PATH;
      } else {
        process.env.CAT_TEMPLATE_PATH = saved;
      }
      _resetCachedConfig();
    }
  });

  it('returns variant catId when default variant has catId override', () => {
    const cfg = multiVariantConfig();
    // Make opus-45 the default and give it a custom catId
    cfg.breeds[0].defaultVariantId = 'opus-45';
    const saved = process.env.CAT_TEMPLATE_PATH;
    const path = writeTempConfig(cfg);
    process.env.CAT_TEMPLATE_PATH = path;
    _resetCachedConfig();
    try {
      const id = getDefaultCatId();
      assert.equal(id, 'opus-45');
    } finally {
      if (saved === undefined) {
        delete process.env.CAT_TEMPLATE_PATH;
      } else {
        process.env.CAT_TEMPLATE_PATH = saved;
      }
      _resetCachedConfig();
    }
  });
});

describe('F32-b: mentionPattern validation', () => {
  it('rejects breed mentionPatterns without @ prefix', () => {
    const cfg = multiVariantConfig();
    cfg.breeds[0].mentionPatterns = ['opus', '@布偶猫'];
    const path = writeTempConfig(cfg);
    assert.throws(() => loadCatConfig(path), /Invalid cat config/);
  });

  it('rejects variant mentionPatterns without @ prefix', () => {
    const cfg = multiVariantConfig();
    cfg.breeds[0].variants[1].mentionPatterns = ['opus-45'];
    const path = writeTempConfig(cfg);
    assert.throws(() => loadCatConfig(path), /Invalid cat config/);
  });

  it('accepts breed mentionPatterns without canonical @catId (custom aliases allowed)', () => {
    const cfg = multiVariantConfig();
    cfg.breeds[0].mentionPatterns = ['@布偶猫', '@布偶'];
    const path = writeTempConfig(cfg);
    const config = loadCatConfig(path);
    const allConfigs = toAllCatConfigs(config);
    assert.deepEqual(allConfigs.opus.mentionPatterns, ['@布偶猫', '@布偶']);
  });

  it('accepts variant mentionPatterns without canonical @catId (custom aliases allowed)', () => {
    const cfg = multiVariantConfig();
    cfg.breeds[0].variants[1].mentionPatterns = ['@布偶猫4.5'];
    const path = writeTempConfig(cfg);
    const config = loadCatConfig(path);
    const allConfigs = toAllCatConfigs(config);
    assert.deepEqual(allConfigs['opus-45'].mentionPatterns, ['@布偶猫4.5']);
  });
});

// ── F32-b P4c: Per-Variant Avatar/Color Override + Personality Fallback ──

describe('F32-b P4c: variant-level avatar/color override', () => {
  /** Config with variant that overrides avatar and color */
  function variantOverrideConfig() {
    const cfg = multiVariantConfig();
    cfg.breeds[0].variants[1].avatar = '/avatars/opus-45.png';
    cfg.breeds[0].variants[1].color = { primary: '#B39DDB', secondary: '#EDE7F6' };
    return cfg;
  }

  it('variant with avatar/color override uses its own values', () => {
    const config = loadCatConfig(writeTempConfig(variantOverrideConfig()));
    const all = toAllCatConfigs(config);
    assert.equal(all['opus-45'].avatar, '/avatars/opus-45.png');
    assert.deepEqual(all['opus-45'].color, { primary: '#B39DDB', secondary: '#EDE7F6' });
  });

  it('default variant still uses breed-level avatar/color', () => {
    const config = loadCatConfig(writeTempConfig(variantOverrideConfig()));
    const all = toAllCatConfigs(config);
    assert.equal(all.opus.avatar, '/avatars/opus.png');
    assert.deepEqual(all.opus.color, { primary: '#9B7EBD', secondary: '#E8DFF5' });
  });

  it('variant without override inherits breed values (unchanged behavior)', () => {
    const cfg = multiVariantConfig();
    // opus-45 has no avatar/color in base multiVariantConfig
    const config = loadCatConfig(writeTempConfig(cfg));
    const all = toAllCatConfigs(config);
    assert.equal(all['opus-45'].avatar, '/avatars/opus.png');
    assert.deepEqual(all['opus-45'].color, { primary: '#9B7EBD', secondary: '#E8DFF5' });
  });
});

describe('F32-b P4c: personality fallback to default variant', () => {
  it('non-default variant without personality inherits default variant personality', () => {
    const cfg = multiVariantConfig();
    // Remove personality from opus-45 to test fallback
    delete cfg.breeds[0].variants[1].personality;
    const config = loadCatConfig(writeTempConfig(cfg));
    const all = toAllCatConfigs(config);
    // Should fall back to default variant personality '温柔'
    assert.equal(all['opus-45'].personality, '温柔');
  });

  it('non-default variant with explicit personality keeps its own', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.equal(all['opus-45'].personality, '快速高效');
  });

  it('default variant personality is used as-is', () => {
    const config = loadCatConfig(writeTempConfig(multiVariantConfig()));
    const all = toAllCatConfigs(config);
    assert.equal(all.opus.personality, '温柔');
  });
});

describe('getCatEffort', () => {
  // Note: Stale cross-provider effort values are now cleaned at write time
  // (when switching providers via PATCH /api/cats/:id), so runtime
  // normalization is no longer needed here.
  it('returns effort from cli config if set', () => {
    const cfg = validConfig();
    cfg.breeds[0].variants[0].cli = {
      command: 'claude',
      outputFormat: 'stream-json',
      effort: 'low',
    };
    const config = loadCatConfig(writeTempConfig(cfg));

    assert.equal(getCatEffort('opus', config), 'low');
  });

  it('returns provider-aware default when not configured', () => {
    const cfg = validConfig();
    cfg.breeds[0].variants[0].clientId = 'openai';
    cfg.breeds[0].variants[0].cli = {
      command: 'codex',
      outputFormat: 'json',
    };
    const config = loadCatConfig(writeTempConfig(cfg));

    assert.equal(getCatEffort('opus', config), 'xhigh');
  });

  it('rejects stale cross-provider effort from historical data (defense-in-depth)', () => {
    // Simulates a catalog written before the PATCH write-time cleanup was added:
    // an openai cat still carrying anthropic-only effort 'max'.
    const cfg = validConfig();
    cfg.breeds[0].variants[0].clientId = 'openai';
    cfg.breeds[0].variants[0].cli = {
      command: 'codex',
      outputFormat: 'json',
      effort: 'max', // invalid for openai — only anthropic supports 'max'
    };
    const config = loadCatConfig(writeTempConfig(cfg));

    // Should fall back to openai default ('xhigh'), not return 'max'
    assert.equal(getCatEffort('opus', config), 'xhigh');
  });
});
describe('F32-b P4c: Sonnet variant in project config', () => {
  it('project cat-template.json loads with Sonnet variant', () => {
    const config = loadCatConfig();
    const ragdoll = config.breeds.find((b) => b.id === 'ragdoll');
    assert.ok(ragdoll, 'ragdoll breed exists');
    const sonnetVariant = ragdoll.variants.find((v) => v.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant exists');
    assert.equal(sonnetVariant.catId, 'sonnet');
    assert.equal(sonnetVariant.variantLabel, 'Sonnet');
    assert.equal(sonnetVariant.clientId, 'anthropic');
    assert.equal(sonnetVariant.defaultModel, 'claude-sonnet-4-6');
  });

  it('Sonnet expands to independent cat with correct overrides', () => {
    const config = loadCatConfig();
    const all = toAllCatConfigs(config);
    const sonnet = all.sonnet;
    assert.ok(sonnet, 'sonnet cat config exists');
    assert.equal(sonnet.breedId, 'ragdoll');
    assert.equal(sonnet.displayName, '布偶猫');
    assert.equal(sonnet.variantLabel, 'Sonnet');
    assert.equal(sonnet.isDefaultVariant, false);
    assert.deepEqual(sonnet.color, { primary: '#B39DDB', secondary: '#EDE7F6' });
    assert.deepEqual(sonnet.mentionPatterns, ['@sonnet', '@布偶sonnet']);
  });

  it('Sonnet does not share avatar/color with default opus', () => {
    const config = loadCatConfig();
    const all = toAllCatConfigs(config);
    // Sonnet has its own color
    assert.notDeepEqual(all.sonnet.color, all.opus.color);
  });

  it('total cat count is 13 (opus + sonnet + opus-45 + codex + gpt52 + spark + gemini + gemini25 + kimi + dare + antigravity + antig-opus + opencode)', () => {
    const config = loadCatConfig();
    const all = toAllCatConfigs(config);
    assert.equal(Object.keys(all).length, 13);
    assert.ok(all.opus);
    assert.ok(all.sonnet);
    assert.ok(all['opus-45']);
    assert.ok(all.codex);
    assert.ok(all.gpt52);
    assert.ok(all.spark); // F032 Phase E: new cat added
    assert.ok(all.gemini);
    assert.ok(all.gemini25);
    assert.ok(all.kimi); // Kimi CLI cat (moonshot)
    assert.ok(all.dare); // F050: DARE external agent (dragon-li)
    assert.ok(all.antigravity); // F061: Bengal cat (Antigravity CDP bridge)
    assert.ok(all['antig-opus']); // F061: Bengal cat Claude variant
    assert.ok(all.opencode); // F105: OpenCode external agent
  });

  it('projects antigravity commandArgs from cli.defaultArgs when variant.commandArgs is absent', () => {
    const config = loadCatConfig();
    const all = toAllCatConfigs(config);
    assert.deepEqual(all.antigravity.commandArgs, ['.', '--remote-debugging-port=9000']);
    assert.deepEqual(all['antig-opus'].commandArgs, ['.', '--remote-debugging-port=9000']);
  });
});

// --- F-Ground-3 R1 fix: caution null semantics ---

describe('F-Ground-3: caution null semantics', () => {
  it('accepts caution: null at breed level (spec says string | null)', () => {
    const cfg = validConfig();
    cfg.breeds[0].caution = null;
    const path = writeTempConfig(cfg);
    // Should NOT throw — null means "explicitly no caution"
    const loaded = loadCatConfig(path);
    assert.equal(loaded.breeds[0].caution, null);
  });

  it('accepts caution: null at variant level', () => {
    const cfg = validConfig();
    cfg.breeds[0].caution = 'breed warning';
    cfg.breeds[0].variants[0].caution = null;
    const path = writeTempConfig(cfg);
    const loaded = loadCatConfig(path);
    assert.equal(loaded.breeds[0].variants[0].caution, null);
  });

  it('variant caution: null overrides breed caution (does not inherit)', () => {
    const cfg = validConfig();
    cfg.breeds[0].caution = 'breed warning';
    cfg.breeds[0].variants[0].caution = null;
    const path = writeTempConfig(cfg);
    const loaded = loadCatConfig(path);
    const all = toAllCatConfigs(loaded);
    // null means "explicitly no caution" — should NOT fallback to breed's caution
    assert.equal(all.opus.caution, null, 'variant null should override breed caution');
  });

  it('variant caution: undefined inherits breed caution', () => {
    const cfg = validConfig();
    cfg.breeds[0].caution = 'breed warning';
    // variant.caution not set → undefined → should inherit
    const path = writeTempConfig(cfg);
    const loaded = loadCatConfig(path);
    const all = toAllCatConfigs(loaded);
    assert.equal(all.opus.caution, 'breed warning');
  });
});

describe('GPT-5.2 variant mention aliases in project config', () => {
  it('includes @gpt5.2 and @gpt-5.2 for gpt52 variant', () => {
    const config = loadCatConfig();
    const all = toAllCatConfigs(config);
    const gpt52 = all.gpt52;
    assert.ok(gpt52, 'gpt52 cat config exists');
    assert.ok(gpt52.mentionPatterns.includes('@gpt5.2'));
    assert.ok(gpt52.mentionPatterns.includes('@gpt-5.2'));
  });

  it('includes stable @gpt alias for gpt52 variant', () => {
    const config = loadCatConfig();
    const all = toAllCatConfigs(config);
    const gpt52 = all.gpt52;
    assert.ok(gpt52, 'gpt52 cat config exists');
    assert.ok(gpt52.mentionPatterns.includes('@gpt'));
  });
});
