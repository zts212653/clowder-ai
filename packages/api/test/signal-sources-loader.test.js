import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const modulePath = '../dist/domains/signals/config/sources-loader.js';

describe('signal sources loader', () => {
  let tempRoot;
  let prevSignalsRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-signals-'));
    prevSignalsRoot = process.env.SIGNALS_ROOT_DIR;
    process.env.SIGNALS_ROOT_DIR = tempRoot;
  });

  afterEach(() => {
    if (prevSignalsRoot === undefined) {
      delete process.env.SIGNALS_ROOT_DIR;
    } else {
      process.env.SIGNALS_ROOT_DIR = prevSignalsRoot;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates expected workspace directories', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths } = await import(modulePath);

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    assert.equal(existsSync(paths.rootDir), true);
    assert.equal(existsSync(paths.configDir), true);
    assert.equal(existsSync(paths.libraryDir), true);
    assert.equal(existsSync(paths.inboxDir), true);
    assert.equal(existsSync(paths.logsDir), true);
    assert.equal(existsSync(paths.sourcesFile), true);
  });

  it('loads default sources config when sources.yaml is empty', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);
    writeFileSync(paths.sourcesFile, '', 'utf-8');

    const config = await loadSignalSources(paths);

    assert.equal(config.version, 1);
    assert.ok(config.sources.length > 0);
    assert.equal(config.sources[0].enabled, true);
  });

  it('parses valid YAML config', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    writeFileSync(
      paths.sourcesFile,
      `version: 1\nsources:\n  - id: openai-rss\n    name: OpenAI RSS\n    url: https://openai.com/news/rss.xml\n    tier: 1\n    category: official\n    enabled: true\n    fetch:\n      method: rss\n    schedule:\n      frequency: daily\n`,
      'utf-8',
    );

    const config = await loadSignalSources(paths);

    assert.ok(config.sources.length > 1, 'should merge defaults into persisted YAML');
    assert.equal(config.sources[0].id, 'openai-rss', 'persisted source comes first');
    assert.equal(config.sources[0].fetch.method, 'rss');
  });

  it('throws on invalid schema', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    writeFileSync(
      paths.sourcesFile,
      `version: 1\nsources:\n  - id: invalid\n    name: Invalid\n    url: https://example.com/feed\n    tier: 9\n    category: official\n    enabled: true\n    fetch:\n      method: rss\n    schedule:\n      frequency: daily\n`,
      'utf-8',
    );

    await assert.rejects(async () => {
      await loadSignalSources(paths);
    });
  });

  it('uses overridden root directory when provided', async () => {
    const { resolveSignalPaths } = await import(modulePath);

    const custom = join(tempRoot, 'custom-signals-home');
    const paths = resolveSignalPaths(custom);

    assert.equal(paths.rootDir, custom);
    assert.equal(paths.sourcesFile, join(custom, 'config', 'sources.yaml'));
  });

  it('falls back to default root when SIGNALS_ROOT_DIR is empty', async () => {
    const { resolveSignalPaths } = await import(modulePath);

    process.env.SIGNALS_ROOT_DIR = '';

    const paths = resolveSignalPaths();
    const expectedRoot = join(homedir(), '.cat-cafe', 'signals');

    assert.equal(paths.rootDir, expectedRoot);
  });

  it('appends new default sources missing from persisted YAML', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);
    const { DEFAULT_SIGNAL_SOURCES } = await import('../dist/domains/signals/config/default-sources.js');

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    // Write a YAML with only 1 source (simulating an old config)
    writeFileSync(
      paths.sourcesFile,
      `version: 1\nsources:\n  - id: anthropic-news\n    name: Anthropic Newsroom\n    url: https://www.anthropic.com/news\n    tier: 1\n    category: official\n    enabled: true\n    fetch:\n      method: webpage\n      selector: "article"\n    schedule:\n      frequency: daily\n`,
      'utf-8',
    );

    const config = await loadSignalSources(paths);

    // Should have the persisted source + all missing defaults
    assert.equal(config.sources.length, DEFAULT_SIGNAL_SOURCES.sources.length);
    assert.equal(config.sources[0].id, 'anthropic-news', 'persisted sources come first');
  });

  it('preserves user-modified enabled=false for existing sources', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);
    const { DEFAULT_SIGNAL_SOURCES } = await import('../dist/domains/signals/config/default-sources.js');

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    const firstDefault = DEFAULT_SIGNAL_SOURCES.sources[0];

    // Write YAML with existing source disabled by user
    writeFileSync(
      paths.sourcesFile,
      `version: 1\nsources:\n  - id: ${firstDefault.id}\n    name: ${firstDefault.name}\n    url: ${firstDefault.url}\n    tier: ${firstDefault.tier}\n    category: ${firstDefault.category}\n    enabled: false\n    fetch:\n      method: ${firstDefault.fetch.method}\n    schedule:\n      frequency: ${firstDefault.schedule.frequency}\n`,
      'utf-8',
    );

    const config = await loadSignalSources(paths);

    const found = config.sources.find((s) => s.id === firstDefault.id);
    assert.equal(found.enabled, false, 'user disabled state must be preserved');
  });

  it('persists merged config to disk', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);
    const { DEFAULT_SIGNAL_SOURCES } = await import('../dist/domains/signals/config/default-sources.js');

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    // Write YAML with only 1 source
    writeFileSync(
      paths.sourcesFile,
      `version: 1\nsources:\n  - id: anthropic-news\n    name: Anthropic Newsroom\n    url: https://www.anthropic.com/news\n    tier: 1\n    category: official\n    enabled: true\n    fetch:\n      method: webpage\n      selector: "article"\n    schedule:\n      frequency: daily\n`,
      'utf-8',
    );

    await loadSignalSources(paths);

    // Read the file back to confirm it was updated
    const updatedYaml = readFileSync(paths.sourcesFile, 'utf-8');
    assert.ok(updatedYaml.includes(DEFAULT_SIGNAL_SOURCES.sources.at(-1).id), 'last default source should be in file');
  });

  it('does not rewrite YAML when all defaults are already present', async () => {
    const { ensureSignalWorkspace, resolveSignalPaths, loadSignalSources } = await import(modulePath);

    const paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    // ensureSignalWorkspace already wrote all defaults; note file mtime
    const before = readFileSync(paths.sourcesFile, 'utf-8');

    await loadSignalSources(paths);

    const after = readFileSync(paths.sourcesFile, 'utf-8');
    assert.equal(before, after, 'YAML should not be rewritten when no new sources');
  });
});
