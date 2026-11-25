// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { createOwnerConsole } from './owner-console';

it('keeps unchanged contribution tools held and changes only the tool with the same contribution/name identity', () => {
  const tools = [
    { contributionId: 'mcp', name: 'first', description: 'Original tool', inputSchema: {} },
    { contributionId: 'mcp', name: 'second', description: 'Unchanged tool', inputSchema: {} },
  ];
  const console = createOwnerConsole({ sources: { settings: { pluginTools: { plugin: tools } } } });
  const before = console.read("projectData('settings').pluginTools.plugin");
  const unchanged = console.push({ settings: { pluginTools: { plugin: structuredClone(tools) } } });
  expect(console.read("projectData('settings').pluginTools.plugin")).toBe(before);
  expect(unchanged.settings).toMatchObject({ added: [], changed: [], removed: [], fields: [] });
  const next = structuredClone(tools);
  next[0].description = 'Changed tool';
  const diff = console.push({ settings: { pluginTools: { plugin: next } } });
  const after = console.read("projectData('settings').pluginTools.plugin");
  expect(after[1]).toBe(before[1]);
  expect(after[0]).toMatchObject({ name: 'first', description: 'Changed tool' });
  expect(diff.settings.changed).toContain(JSON.stringify(['mcp', 'first']));
});

it('projects package descriptions, documentation and provided capabilities without translating them', async () => {
  const description = { default: 'Package description', translations: { 'zh-CN': '包的原始描述' } };
  const plugin = {
    pluginId: 'fixture.plugin',
    displayName: 'Fixture',
    description,
    icon: 'puzzle',
    source: { kind: 'catalog', trust: 'official', packageName: '@fixture/plugin' },
    publisher: 'Fixture publisher',
    installedVersion: '1.0',
    availableVersion: '1.0',
    artifact: 'installed',
    intent: 'enabled',
    live: 'running',
    config: 'ready',
    auth: 'connected',
    actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
    configFields: [{ key: 'url', label: 'Endpoint', kind: 'url', currentValue: null }],
    capabilities: [],
    contributions: [{ id: 'fixture.mcp', kind: 'mcp', name: 'Fixture MCP', description: 'Capability body' }],
  };
  const owner = {
    plugins: { plugins: [plugin] },
    pluginFragments: {},
    pluginDetails: { [plugin.pluginId]: plugin },
    pluginLibraries: {},
    pluginTools: { [plugin.pluginId]: [{ contributionId: 'fixture.mcp', name: 'fixture_tool' }] },
    pluginDocumentation: { [plugin.pluginId]: { readmeMarkdown: '# Package README' } },
  };
  const starts: Record<string, (() => unknown)[]> = {};
  const context = createContext({
    navArg: () => null,
    S: { route: 'extItem', param: plugin.pluginId },
    A: {},
    VM: {},
    pdlReads: (() => {
      const who = {};
      return () => who;
    })(),
    PAGES: {},
    TITLES: {},
    INPUTS: {},
    CHANGES: {},
    SET_AFTER: {},
    ENT: {},
    MENU_FNS: {},
    api: { on: vi.fn() },
    chatPort: { action: vi.fn() },
    projectionNeeded: new Set(),
    placementData: () => owner,
    pcfState: () => ({}),
    pcfDirty: () => false,
    pcfModel: () => ({}),
    tc: (key: string) => key,
    pdlPlace: () => ({}),
    PDL_SLOT_REJECTS: {},
    PDL_INSERT_SKIPS: {},
    ENGINE_PARTS: {},
    onStart: (phase: string, callback: () => unknown) => (starts[phase] ??= []).push(callback),
  });
  runInContext(readFileSync('public/pdl-app/plugins.js', 'utf8'), context);
  runInContext('bindPluginSpaces()', context);
  const emptyCounts = { all: 0, attention: 0, installed: 0, available: 0 };
  expect(runInContext('VM.ext()', context)).toMatchObject({ load: 'loading', counts: emptyCounts, browserGroups: [] });

  context.chatPort.action.mockRejectedValueOnce(new Error('Inventory unavailable'));
  await starts.data[0]();
  expect(runInContext('VM.ext()', context)).toMatchObject({ load: 'error', counts: emptyCounts, browserGroups: [] });

  await starts.data[0]();
  const model = runInContext('VM.ext()', context);
  expect(model.groups[0]).toMatchObject({ kind: 'installed' });
  expect(model.sel.desc).toBe(description);
  expect(model.sel.publisher).toBe('Fixture publisher');
  expect(model.sel.docs.readme).toBe('# Package README');
  expect(model.sel.docs.provides).toMatchObject([
    { kind: 'mcps', items: [{ title: 'Fixture MCP', sub: 'Capability body', tools: ['fixture_tool'] }] },
  ]);
  expect(model.sel.config.save.dirty).toBe(false);
  expect(model).toMatchObject({
    scope: 'all',
    counts: { all: 1, attention: 0, installed: 1, available: 0 },
    browserGroups: [
      { kind: 'attention', items: [] },
      { kind: 'installed', items: [{ artifact: 'installed', trust: 'official' }] },
      { kind: 'available', items: [] },
    ],
  });
  expect(model.sel.docs.capabilities).toMatchObject([{ kind: 'mcps', items: [{ title: 'Fixture MCP' }] }]);
  plugin.availableVersion = '2.0';
  const updated = runInContext('VM.ext()', context);
  expect(updated.sel).toMatchObject({ hasUpdate: true, availableVersion: '2.0', canUninstall: true });
  expect(updated.counts.attention).toBe(1);
  expect(updated.browserGroups[0].items).toHaveLength(1);
  expect(updated.browserGroups[1].items).toHaveLength(0);
  const companion = { ...plugin, pluginId: 'official.companion', artifact: 'installed' };
  owner.plugins.plugins = [companion];
  owner.pluginDetails[companion.pluginId] = companion;
  context.navArg = () => 'companion';
  context.chatRead = () => ({ cats: [{ id: 'codex', nickname: 'Owner member', roster: { available: true } }] });
  context.pcfModel = (id: string, form: { installed: boolean; fields: unknown[] }) => ({
    p: id,
    installed: form.installed,
    rows: form.fields,
  });
  const concierge = runInContext('VM.ext()', context);
  expect(concierge.sel.key).toBe('official.companion');
  expect(concierge.companion).toMatchObject({
    p: 'official.companion',
    installed: true,
    partners: [{ id: 'codex', name: 'Owner member', on: true }],
  });
});
