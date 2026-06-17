import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import { readCapabilitiesConfig } from '../../dist/config/capabilities/capability-orchestrator.js';
import { readMountRules, validateMountRules, writeMountRules } from '../../dist/config/mount/mount-rules-store.js';

let tempDir;

describe('MountRulesStore (F228)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mount-rules-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('readMountRules returns DEFAULT when no capabilities.json exists', async () => {
    const result = await readMountRules(tempDir);
    assert.deepEqual(result, DEFAULT_MOUNT_RULES);
  });

  test('readMountRules returns clone — mutating result does not affect DEFAULT', async () => {
    const result = await readMountRules(tempDir);
    result.customPaths.push({ alias: 'evil', path: '/tmp/evil' });
    assert.deepEqual(DEFAULT_MOUNT_RULES.customPaths, [], 'DEFAULT must remain pristine');
  });

  test('writeMountRules then readMountRules roundtrip preserves custom config', async () => {
    const custom = {
      version: 1,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: true, path: '.gemini/skills' },
        kimi: { enabled: true, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'opencode', path: '.opencode/skills' }],
    };
    await writeMountRules(tempDir, custom);
    const back = await readMountRules(tempDir);
    assert.deepEqual(back, custom);
    // Verify it wrote to capabilities.json, not mount-rules.json
    const config = await readCapabilitiesConfig(tempDir);
    assert.ok(Array.isArray(config.mountRules), 'mountRules should be in capabilities.json');
  });

  test('writeMountRules creates capabilities.json when missing', async () => {
    await writeMountRules(tempDir, DEFAULT_MOUNT_RULES);
    const config = await readCapabilitiesConfig(tempDir);
    assert.equal(config.version, 2, 'should create v2 config');
    assert.ok(Array.isArray(config.mountRules), 'should contain mountRules');
  });

  test('validateMountRules accepts the canonical DEFAULT', () => {
    assert.deepEqual(validateMountRules(DEFAULT_MOUNT_RULES), DEFAULT_MOUNT_RULES);
  });

  test('validateMountRules rejects missing standard provider', () => {
    const broken = {
      version: 1,
      mountPoints: { claude: { enabled: true, path: '.claude/skills' } },
      customPaths: [],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules accepts legacy rules without customPaths field (F228 P2)', () => {
    // Legacy mount-rules.json predates customPaths — missing field should default to []
    const legacy = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
    };
    const result = validateMountRules(legacy);
    assert.ok(result, 'legacy rules without customPaths must be accepted');
    assert.deepEqual(result.customPaths, [], 'missing customPaths defaults to []');
    assert.deepEqual(result.mountPoints, DEFAULT_MOUNT_RULES.mountPoints, 'mountPoints preserved');
  });

  test('validateMountRules rejects customPaths entry with empty alias', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: '', path: '/x' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects customPaths aliases that collide with standard providers', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'claude', path: '.custom-claude/skills' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects customPaths alias with path separators', () => {
    for (const bad of ['../../escaped', 'a/b', 'a\\b', '..', '.hidden', 'has space', 'UPPER']) {
      const broken = {
        version: 1,
        mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
        customPaths: [{ alias: bad, path: '/tmp/skills' }],
      };
      assert.equal(validateMountRules(broken), null, `alias "${bad}" should be rejected`);
    }
  });

  test('validateMountRules rejects duplicate customPaths aliases', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [
        { alias: 'acp', path: '.acp/skills' },
        { alias: 'acp', path: '.other-acp/skills' },
      ],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules accepts project-relative customPaths entries', () => {
    const rules = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'opencode', path: '.opencode/skills' }],
    };
    assert.deepEqual(validateMountRules(rules), rules);
  });

  test('validateMountRules rejects project-relative customPaths entries that escape project root', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'opencode', path: '../outside/skills' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects customPaths entries with surrounding whitespace', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'opencode', path: ' ~/.opencode/skills' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects customPaths entries with NUL bytes', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'opencode', path: '/tmp/skills\0x' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects HOME customPaths entries', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'opencode', path: '~/.opencode/skills' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects absolute customPaths entries', () => {
    const broken = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'opencode', path: '/tmp/opencode/skills' }],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects Windows-only custom paths on POSIX', () => {
    if (process.platform === 'win32') return; // only meaningful on POSIX
    const driveLetterPath = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'win', path: 'C:\\Users\\foo\\skills' }],
    };
    assert.equal(validateMountRules(driveLetterPath), null, 'C:\\ path must be rejected on POSIX');

    const uncPath = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'unc', path: '\\\\server\\share\\skills' }],
    };
    assert.equal(validateMountRules(uncPath), null, 'UNC path must be rejected on POSIX');
  });

  test('validateMountRules rejects ~\\\\ custom paths on POSIX', () => {
    if (process.platform === 'win32') return;
    const backslashHome = {
      version: 1,
      mountPoints: DEFAULT_MOUNT_RULES.mountPoints,
      customPaths: [{ alias: 'bshome', path: '~\\skills' }],
    };
    assert.equal(validateMountRules(backslashHome), null, '~\\\\ must be rejected on POSIX');
  });

  test('validateMountRules rejects non-object input', () => {
    assert.equal(validateMountRules(null), null);
    assert.equal(validateMountRules(42), null);
    assert.equal(validateMountRules('hello'), null);
    assert.equal(validateMountRules([]), null);
  });

  test('validateMountRules rejects provider with non-boolean enabled', () => {
    const broken = {
      version: 1,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: 'yes', path: '.kimi/skills' },
      },
      customPaths: [],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects provider paths that escape project root', () => {
    const broken = {
      version: 1,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '../../outside' },
      },
      customPaths: [],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('validateMountRules rejects absolute provider paths', () => {
    const broken = {
      version: 1,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '/tmp/skills' },
      },
      customPaths: [],
    };
    assert.equal(validateMountRules(broken), null);
  });

  test('writeMountRules persists to capabilities.json#mountRules for v2 projects', async () => {
    // Set up a v2 capabilities.json
    const v2Config = {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', source: 'cat-cafe', enabled: true }],
      mountRules: [],
    };
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(join(tempDir, '.cat-cafe/capabilities.json'), JSON.stringify(v2Config));

    const custom = {
      version: 1,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: true, path: '.gemini/skills' },
        kimi: { enabled: true, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'opencode', path: '.opencode/skills' }],
    };
    await writeMountRules(tempDir, custom);

    // Verify capabilities.json was updated (not legacy file)
    const updatedConfig = await readCapabilitiesConfig(tempDir);
    assert.equal(updatedConfig.version, 2);
    assert.ok(Array.isArray(updatedConfig.mountRules), 'mountRules should be array');
    assert.equal(updatedConfig.mountRules.length, 5, '4 standard + 1 custom');

    // Verify roundtrip: readMountRules reads back from v2 path
    const back = await readMountRules(tempDir);
    assert.equal(back.mountPoints.claude.enabled, true);
    assert.equal(back.mountPoints.codex.enabled, false);
    assert.equal(back.customPaths.length, 1);
    assert.equal(back.customPaths[0].alias, 'opencode');
  });

  test('writeMountRules always writes to capabilities.json', async () => {
    await writeMountRules(tempDir, DEFAULT_MOUNT_RULES);
    const config = await readCapabilitiesConfig(tempDir);
    assert.ok(config, 'capabilities.json must exist');
    assert.ok(Array.isArray(config.mountRules), 'mountRules must be set');
    assert.equal(config.mountRules.length, 4, 'should have 4 standard providers');
  });

  test('readMountRules inherits defaultMountRules from main project when external project has no own mountRules', async () => {
    // Main project: has defaultMountRules with codex disabled
    const mainDir = await mkdtemp(join(tmpdir(), 'main-project-'));
    try {
      const mainConfig = {
        version: 2,
        capabilities: [],
        defaultMountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: true },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
      };
      await mkdir(join(mainDir, '.cat-cafe'), { recursive: true });
      await writeFile(join(mainDir, '.cat-cafe/capabilities.json'), JSON.stringify(mainConfig));

      // External project: v2 config with no mountRules
      const extConfig = { version: 2, capabilities: [] };
      await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
      await writeFile(join(tempDir, '.cat-cafe/capabilities.json'), JSON.stringify(extConfig));

      // Without mainProjectRoot: falls back to DEFAULT (all enabled)
      const withoutMain = await readMountRules(tempDir);
      assert.equal(withoutMain.mountPoints.codex.enabled, true, 'without main: codex should be default-enabled');

      // With mainProjectRoot: inherits defaultMountRules (codex disabled)
      const inherited = await readMountRules(tempDir, mainDir);
      assert.equal(inherited.mountPoints.codex.enabled, false, 'with main: codex should inherit disabled');
      assert.equal(inherited.mountPoints.claude.enabled, true, 'claude should inherit enabled');
      assert.equal(inherited.mountPoints.gemini.enabled, true, 'gemini should inherit enabled');
    } finally {
      await rm(mainDir, { recursive: true, force: true });
    }
  });

  test('readMountRules applies defaultMountRules to main project when it has no own mountRules', async () => {
    const mainDir = await mkdtemp(join(tmpdir(), 'main-project-'));
    try {
      const mainConfig = {
        version: 2,
        capabilities: [],
        defaultMountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
      };
      await mkdir(join(mainDir, '.cat-cafe'), { recursive: true });
      await writeFile(join(mainDir, '.cat-cafe/capabilities.json'), JSON.stringify(mainConfig));

      const result = await readMountRules(mainDir, mainDir);
      assert.equal(
        result.mountPoints.codex.enabled,
        false,
        'main project should use defaultMountRules when own rules absent',
      );
      assert.equal(result.mountPoints.claude.enabled, true, 'main project should preserve enabled default providers');
    } finally {
      await rm(mainDir, { recursive: true, force: true });
    }
  });

  test('readMountRules uses project own mountRules before main defaultMountRules', async () => {
    const mainDir = await mkdtemp(join(tmpdir(), 'main-project-'));
    try {
      const mainConfig = {
        version: 2,
        capabilities: [],
        defaultMountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
      };
      await mkdir(join(mainDir, '.cat-cafe'), { recursive: true });
      await writeFile(join(mainDir, '.cat-cafe/capabilities.json'), JSON.stringify(mainConfig));

      const projectOverride = {
        version: 1,
        mountPoints: {
          claude: { enabled: true, path: '.claude/skills' },
          codex: { enabled: true, path: '.project-codex/skills' },
          gemini: { enabled: false, path: '.gemini/skills' },
          kimi: { enabled: true, path: '.kimi/skills' },
        },
        customPaths: [{ alias: 'opencode', path: '.opencode/skills' }],
      };
      await writeMountRules(tempDir, projectOverride);

      const result = await readMountRules(tempDir, mainDir);
      assert.equal(result.mountPoints.codex.enabled, true, 'project override should beat inherited default');
      assert.equal(result.mountPoints.codex.path, '.project-codex/skills');
      assert.equal(result.mountPoints.gemini.enabled, false, 'disabled provider should be preserved');
      assert.deepEqual(result.customPaths, [{ alias: 'opencode', path: '.opencode/skills' }]);
    } finally {
      await rm(mainDir, { recursive: true, force: true });
    }
  });

  test('readMountRules uses project own mountRules over main defaultMountRules', async () => {
    // Main project: defaultMountRules has codex disabled
    const mainDir = await mkdtemp(join(tmpdir(), 'main-project-'));
    try {
      const mainConfig = {
        version: 2,
        capabilities: [],
        defaultMountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: false },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
      };
      await mkdir(join(mainDir, '.cat-cafe'), { recursive: true });
      await writeFile(join(mainDir, '.cat-cafe/capabilities.json'), JSON.stringify(mainConfig));

      // External project: has its own mountRules (codex enabled)
      const extConfig = {
        version: 2,
        capabilities: [],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: true },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
      };
      await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
      await writeFile(join(tempDir, '.cat-cafe/capabilities.json'), JSON.stringify(extConfig));

      // Project's own mountRules should win over defaultMountRules
      const result = await readMountRules(tempDir, mainDir);
      assert.equal(result.mountPoints.codex.enabled, true, 'project override: codex should be enabled');
    } finally {
      await rm(mainDir, { recursive: true, force: true });
    }
  });

  test('readMountRules filters unsafe custom mountRules entries from v2 config', async () => {
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(tempDir, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: true },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
          { name: 'home-opencode', path: '~/.opencode/skills', enabled: true },
          { name: 'project-opencode', path: '.opencode/skills', enabled: true },
        ],
      }),
    );

    const rules = await readMountRules(tempDir);
    assert.deepEqual(rules.customPaths, [{ alias: 'project-opencode', path: '.opencode/skills' }]);
  });

  test('readMountRules excludes disabled custom mountRules entries from v2 config', async () => {
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(tempDir, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '.codex/skills', enabled: true },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
          { name: 'acp', path: '.acp/skills', enabled: false },
        ],
      }),
    );

    const rules = await readMountRules(tempDir);
    assert.deepEqual(rules.customPaths, [], 'disabled custom rules must not become active mount targets');
  });

  test('readMountRules disables invalid standard mountRules entries from v2 config', async () => {
    await mkdir(join(tempDir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(tempDir, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [],
        mountRules: [
          { name: 'claude', path: '.claude/skills', enabled: true },
          { name: 'codex', path: '../outside/skills', enabled: true },
          { name: 'gemini', path: '.gemini/skills', enabled: true },
          { name: 'kimi', path: '.kimi/skills', enabled: true },
        ],
      }),
    );

    const rules = await readMountRules(tempDir);
    assert.equal(rules.mountPoints.codex.enabled, false, 'invalid standard rule must not fall back to enabled default');
    assert.equal(rules.mountPoints.codex.path, DEFAULT_MOUNT_RULES.mountPoints.codex.path);
    assert.equal(rules.mountPoints.claude.enabled, true, 'valid sibling standard rule should be preserved');
  });
});
