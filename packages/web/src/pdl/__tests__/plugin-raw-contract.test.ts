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
    actions: { install: false, setEnabled: true, uninstall: true },
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
    S: { route: 'extItem', param: plugin.pluginId },
    A: {},
    VM: {},
    WHO_DATA: {},
    PAGES: {},
    TITLES: {},
    INPUTS: {},
    CHANGES: {},
    ENT: {},
    MENU_FNS: {},
    api: { on: vi.fn() },
    chatPort: { action: vi.fn() },
    projectionNeeded: new Set(),
    placementData: () => owner,
    dataOk: vi.fn(),
    dataError: vi.fn(),
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
});
