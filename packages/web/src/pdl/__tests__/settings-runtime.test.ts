// @vitest-environment node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CLIENT_OPTIONS, carrierOptionsForClient, initialState } from '@/components/hub-cat-editor.model';
import { chatModels } from '../chat-models';
import { scriptSources } from '../runtime';
import type { ChatPort } from '../types';
import { fixtureData, fixtureInput, fixtureSidebar, fixtureUi } from './chat-fixture';
import { fixtureWorkbenchSource } from './owner-console';
import { environmentSummaryFixture, ownerData, settingsInput, systemSummaryFixture } from './owner-fixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the jsdom window is loaded untyped
function declaredMenu(w: any, action: string, scope = '') {
  const nodes = Array.from(w.document.querySelectorAll(scope + '[data-menu]')) as HTMLElement[];
  const trigger = nodes.find((el) => {
    const items = w.eval('menuItems(' + JSON.stringify(el.dataset.menu) + ',' + JSON.stringify(el.dataset) + ')');
    return items.some((item: { act: string }) => item.act === action);
  })!;
  expect(trigger).toBeDefined();
  w.menuTrigger = trigger;
  w.eval('A.menu(actionArgs(window.menuTrigger),window.menuTrigger)');
  return w.eval('S.menu.items');
}
const { JSDOM } = createRequire(import.meta.url)('jsdom');
async function boot(
  plugins: unknown[] = [],
  publish?: (
    port: Pick<ChatPort, 'data' | 'sidebarData'>,
    console: typeof window,
    next: Record<string, unknown>,
  ) => void,
) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://pdl.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const errors = vi.spyOn(w.console, 'error').mockImplementation(() => {});
  await new Promise<void>((resolve) => w.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  w.document.timeline = { currentTime: 0 };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.CSS = { escape: (s: string) => s, supports: () => true };
  w.HTMLElement.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.showPopover = () => {};
  w.HTMLElement.prototype.hidePopover = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.document.getAnimations = () => [];
  w.document.fonts = { ready: Promise.resolve() };
  const theme = readFileSync(path.join(process.cwd(), 'public/pdl/theme/default/pdl.js'), 'utf8');
  w.document.documentElement.style.setProperty(
    '--hold-toast',
    JSON.parse(`[${theme.slice(theme.indexOf('pdlThemeLoad(') + 13, theme.lastIndexOf(')'))}]`)[0].tokens.base[
      '--hold-toast'
    ],
  );
  for (const source of scriptSources)
    runInContext(readFileSync(path.join(process.cwd(), 'public', source), 'utf8'), dom.getInternalVMContext(), {
      filename: source,
    });
  const data = fixtureData(),
    ui = fixtureUi(),
    voiceState = ui.voice;
  Object.assign(data.cats[0], { clientId: 'openai', carrier: 'app_server' });
  const get = vi.fn<(name: string, params?: Record<string, unknown>) => Promise<unknown>>(async (name) => {
    if (name === '/api/config/env-summary?surface=system') return systemSummaryFixture();
    if (name === '/api/config/env-summary') return environmentSummaryFixture();
    if (name === '/api/config/console-themes') return { themes: null };
    if (name === '/api/config/chat-background') return { threads: {} };
    if (name === '/api/config/chat-background/images') return { images: [] };
    if (name === '/api/plugin-manager/plugins') return { plugins };
    if (name === '/api/plugin-manager/pdl') return { fragments: {} };
    if (name === '/api/dossier') return { meta: { dossierCoverage: 0, totalCats: 0, totalModels: 0 }, modelGroups: [] };
    if (name === '/api/capabilities') return { skills: [], mcps: [] };
    if (name === '/api/skills') return { skills: [] };
    if (name === '/api/mcp/servers') return { servers: [] };
    if (name === '/api/mount-rules') return { rules: [] };
    if (name === '/api/mcp/config') return { mcpServers: {} };
    if (name === '/api/dossier/observations') return { observations: [] };
    if (name === '/api/concierge/work/decisions')
      return { status: 'available', items: [], page: { offset: 0, limit: 20, hasMore: false } };
    if (name === '/api/concierge/confirmations') return { confirmations: [] };
    if (name === '/api/concierge/thread') return { threadId: null };
    if (name === '/api/concierge/work/mentions/last-handling') return { receipt: null };
    throw new Error('Unexpected read: ' + name);
  });
  const post = vi.fn<(name: string, params: Record<string, unknown>, body: unknown) => Promise<unknown>>(
    async () => ({}),
  );
  const action = vi.fn<(name: string, args: Record<string, string>, element?: HTMLElement) => Promise<unknown>>(
    async (name) =>
      name === 'pushClientRead'
        ? { isSupported: true, permission: 'granted', isSubscribed: false, worker: 'registered' }
        : undefined,
  );
  let input = fixtureInput(data) as Record<string, unknown>;
  const port = {
    needed: vi.fn(),
    threadId: data.threadId,
    exportReady: Promise.resolve(),
    state: ui,
    get data() {
      return input;
    },
    set data(value: Record<string, unknown>) {
      const project = value.project as Record<string, object>;
      input = {
        ...value,
        project: {
          ...project,
          ...('settings' in project ? { settings: { ...settingsInput(), ...project.settings } } : {}),
        },
      };
    },
    sidebarData: fixtureSidebar(data),
    models: vi.fn(() => {
      throw new Error('Settings VMs must read held data, never the host model builder');
    }),
    get,
    post,
    action: action as (name: string, args: Record<string, string>, element?: HTMLElement) => Promise<unknown>,
    file: (s: string) => s,
    richRender: async () => '',
    navResize: { width: () => 240, min: 160, max: () => 400 },
    attach() {},
    live: () => '',
  };
  const command = port.action;
  port.action = async (...args) => {
    const previous = port.data;
    try {
      if (args[0] === 'settingsEnvRead') {
        const env = await get('/api/config/env-summary'),
          project = port.data.project as Record<string, object>;
        port.data = { ...port.data, project: { ...project, settings: { ...project.settings, env } } };
        return true;
      }
      if (args[0] === 'settingsSystemRead') {
        const system = await get('/api/config/env-summary?surface=system'),
          project = port.data.project as Record<string, object>;
        port.data = { ...port.data, project: { ...project, settings: { ...project.settings, system } } };
        return true;
      }
      if (args[0] === 'settingsPluginsRead') {
        const plugins = await get('/api/plugin-manager/plugins'),
          pdl = (await get('/api/plugin-manager/pdl')) as { fragments: object };
        const project = port.data.project as Record<string, object>;
        port.data = {
          ...port.data,
          project: { ...project, settings: { ...project.settings, plugins, pluginFragments: pdl.fragments } },
        };
        return true;
      }
      if (args[0] === 'settingsPluginDetailRead') {
        const id = args[1].id,
          response = (await get('/api/plugin-manager/plugins/' + encodeURIComponent(id))) as {
            plugin: { configFields: { kind: string }[] };
          };
        const project = port.data.project as Record<string, object>,
          settings = project.settings as ReturnType<typeof settingsInput>;
        port.data = {
          ...port.data,
          project: {
            ...project,
            settings: {
              ...settings,
              pluginDetails: { ...settings.pluginDetails, [id]: { contributions: [], ...response.plugin } },
              pluginLibraries: { ...settings.pluginLibraries, [id]: [] },
            },
          },
        };
        return true;
      }
      return await command(...args);
    } finally {
      if (publish) {
        const next = port.data;
        port.data = previous;
        publish(port, w, next);
      } else w.clowderChat.update(port);
    }
  };
  await w.clowderChat.start(port, chatModels);
  await w.__settled();
  action.mockClear();
  return { dom, w, data, voiceState, get, post, action, errors, port };
}

it.each([
  { artifact: 'installed', install: false, availableVersion: '1.0.0', update: false },
  { artifact: 'installed', install: true, availableVersion: '1.1.0', update: true },
  { artifact: 'installed', install: false, availableVersion: '0.9.0', update: false },
  { artifact: 'absent', install: true, availableVersion: '1.0.0', update: false },
])('draws only the admitted plugin operation for $artifact/$availableVersion', async (state) => {
  const plugin = {
    pluginId: 'fixture.lifecycle',
    displayName: 'Lifecycle fixture',
    source: { kind: 'catalog', trust: 'official' },
    artifact: state.artifact,
    intent: 'disabled',
    live: 'stopped',
    config: 'ready',
    auth: 'not-required',
    installedVersion: state.artifact === 'installed' ? '1.0.0' : null,
    availableVersion: state.availableVersion,
    actions: { install: state.install, setEnabled: true, uninstall: true, blockingReasons: [] },
    configFields: [],
    contributions: [],
  };
  const { dom, w, get, errors } = await boot([plugin]);
  const previous = get.getMockImplementation()!;
  get.mockImplementation((name, params) =>
    name === '/api/plugin-manager/plugins/' + plugin.pluginId ? Promise.resolve({ plugin }) : previous(name, params),
  );
  try {
    w.eval("go('ext')");
    await w.__settled();
    const page = w.document.querySelector('[data-view="page.ext"]')!;
    expect(page.querySelectorAll('[data-act="install"][data-k="fixture.lifecycle"]')).toHaveLength(
      state.artifact === 'absent' ? 2 : 0,
    );
    expect(page.querySelectorAll('[data-act="capUpdate"][data-k="fixture.lifecycle"]')).toHaveLength(
      state.update ? 2 : 0,
    );
    expect(page.querySelectorAll('[data-act="remove"][data-entity="plugin"]')).toHaveLength(
      state.artifact === 'installed' ? 1 : 0,
    );
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('demands tools only for the projected active plugin and retains their held base across inactive states', async () => {
  const plugin = {
    pluginId: 'fixture.inactive',
    displayName: 'Inactive fixture',
    source: { kind: 'catalog', trust: 'official' },
    artifact: 'installed',
    intent: 'disabled',
    live: 'stopped',
    config: 'ready',
    auth: 'not-required',
    actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
    configFields: [],
    contributions: [{ id: 'fixture.mcp', kind: 'mcp', name: 'Fixture MCP' }],
  };
  const tools = [{ contributionId: 'fixture.mcp', name: 'held_tool', inputSchema: {} }];
  const { dom, w, get, action, errors, port } = await boot([plugin]);
  const previous = get.getMockImplementation()!;
  get.mockImplementation((name, params) =>
    name === '/api/plugin-manager/plugins/' + plugin.pluginId ? Promise.resolve({ plugin }) : previous(name, params),
  );
  const push = (intent: string, live: string) => {
    const project = port.data.project as Record<string, object>;
    const settings = project.settings as ReturnType<typeof settingsInput>;
    port.data = {
      ...port.data,
      project: {
        ...project,
        settings: {
          ...settings,
          plugins: { plugins: [{ ...plugin, intent, live }] },
          pluginTools: { [plugin.pluginId]: tools },
        },
      },
    };
    w.clowderChat.update(port);
  };
  const reads = () => action.mock.calls.filter(([name]) => name === 'settingsPluginToolsRead');
  try {
    w.eval("go('ext')");
    await w.__settled();
    expect(get).toHaveBeenCalledWith('/api/plugin-manager/plugins/' + plugin.pluginId);
    expect(reads()).toHaveLength(0);
    expect(get.mock.calls.some(([name]) => name.endsWith('/contributions/tools'))).toBe(false);
    push('enabled', 'starting');
    await w.__settled();
    expect(reads()).toHaveLength(0);
    push('enabled', 'running');
    await w.__settled();
    expect(reads()).toHaveLength(1);
    expect(reads()[0][1]).toEqual({ id: plugin.pluginId });
    expect(w.eval('VM.ext().sel.docs.provides[0].items[0].tools')).toEqual(['held_tool']);
    w.eval('render(true)');
    await w.__settled();
    expect(reads()).toHaveLength(1);
    push('disabled', 'stopped');
    await w.__settled();
    expect(w.eval('VM.ext().sel.docs.provides[0].items[0].tools')).toEqual([]);
    expect(reads()).toHaveLength(1);
    w.eval("go('home')");
    push('enabled', 'running');
    await w.__settled();
    expect(reads()).toHaveLength(1);
    w.eval("go('ext')");
    await w.__settled();
    expect(reads()).toHaveLength(2);
    expect(w.eval('VM.ext().sel.docs.provides[0].items[0].tools')).toEqual(['held_tool']);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('publishes plugin receipts into the held snapshot during startup before the first screen is mounted', async () => {
  const source = readFileSync(path.join(process.cwd(), 'src/pdl/PdlAppHost.tsx'), 'utf8');
  const body = source.split('const publishData = useCallback(() => {')[1].split(/\n {2}}, \[[^\]]*\]\);/)[0];
  const plugin = { pluginId: 'startup.plugin', displayName: 'Startup owner', artifact: 'installed', intent: 'enabled' };
  const { dom, w, get, errors, port } = await boot([plugin], (port, console, next) => {
    const publish = new console.Function(
      'port',
      'inputSnapshot',
      'sidebarSnapshot',
      'project',
      'engineMounted',
      'lastSidebar',
      'current',
      transpileModule(body, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
    );
    publish(
      { current: port },
      () => next,
      () => port.sidebarData,
      { current: {} },
      false,
      {},
      { current: fixtureData() },
    );
  });
  try {
    expect(get).toHaveBeenCalledWith('/api/plugin-manager/plugins');
    expect(get).toHaveBeenCalledWith('/api/plugin-manager/pdl');
    expect(w.eval('chatDataSnapshot.project.settings.plugins.plugins')).toEqual([plugin]);
    expect(w.eval('S.plugins["startup.plugin"]')).toEqual({ installed: true, on: true });
    expect(port.models).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

function capabilityData() {
  return {
    items: [
      {
        id: 'skill-one',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        globalEnabled: true,
        category: 'Development',
        description: 'Actual skill',
        cats: { codex: true },
        mountPaths: ['codex'],
        mounts: { codex: true },
        requiresMcp: [],
      },
      {
        id: 'mcp-one',
        type: 'mcp',
        source: 'external',
        enabled: true,
        description: 'Actual MCP',
        cats: { codex: true },
        mcpServer: { command: 'node', args: ['owner.mjs'], env: { TOKEN: '[REDACTED]' } },
      },
    ],
    allCats: [{ catId: 'codex', displayName: 'Codex' }],
    knownProjectPaths: ['/workspace/fixture'],
  };
}

it('projects the inherited member model and its source from the requested catalog without changing native account binding', async () => {
  const { dom, w, action, data, port, errors } = await boot();
  const runtime = {
    id: 'codex',
    clientId: 'openai',
    label: 'Codex',
    installed: true,
    models: [],
    readiness: { status: 'configured', checkedAt: 1 },
    form: { ...initialState(), clientId: 'openai', carrier: 'app_server' },
  };
  const metadata = {
    accounts: [],
    templates: [],
    blank: initialState(),
    codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    strategies: [],
    libraries: [],
    runtimes: [runtime],
    clients: CLIENT_OPTIONS.map((client) => ({
      id: client.value,
      label: client.label,
      carriers: carrierOptionsForClient(client.value).map((row) => [row.value, row.label]),
      accounts: [],
    })),
  };
  Object.assign(data.cats[0], { defaultModel: '', configurationSource: 'native_tool', accountRef: '' });
  port.data = { ...port.data, chat: fixtureInput(data).chat };
  w.clowderChat.update(port);
  action.mockImplementation(async (name) => {
    if (name === 'membersRead') return metadata;
    if (name === 'memberCanonRead') return { bound: false, versions: [] };
    if (name === 'memberRuntimeModels')
      return {
        status: 'live',
        models: [{ value: 'gpt-tool', label: 'GPT tool' }],
        defaultModel: 'gpt-tool',
        defaultModelLabel: 'GPT tool',
        defaultModelSource: 'client_report',
        defaultModelStatus: 'reported',
      };
  });
  try {
    expect(action.mock.calls.filter(([name]) => name === 'memberRuntimeModels')).toHaveLength(0);
    w.eval("go('members')");
    await w.__settled();
    expect(w.eval('VM.members().rows[0]')).toMatchObject({
      model: 'gpt-tool',
      modelLabel: 'GPT tool',
      modelSource: 'client_report',
      modelStatus: 'reported',
    });
    expect(w.document.querySelector('[data-view="page.members"]').textContent).toContain('gpt-tool');
    const reads = action.mock.calls.filter(([name]) => name === 'memberRuntimeModels');
    expect(reads).toHaveLength(1);
    expect(JSON.parse(reads[0][1].value)).toEqual({
      runtimeId: 'codex',
      catId: 'codex',
      customStartup: false,
      refresh: false,
    });
    w.eval('VM.members(); VM.members(); render(true)');
    await w.__settled();
    expect(action.mock.calls.filter(([name]) => name === 'memberRuntimeModels')).toHaveLength(1);
    w.eval("go('member-codex')");
    await w.__settled();
    expect(w.eval('VM.member()')).toMatchObject({
      model: 'gpt-tool',
      modelSource: 'client_report',
      form: {
        configurationSource: 'native_tool',
        accountRef: '',
        nativeLogin: { status: 'configured' },
        d: { acc: '' },
      },
    });
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

describe('r3b36 member menus through copied controls', () => {
  async function memberEditor() {
    const env = await boot(),
      { w, action } = env;
    const metadata = {
      accounts: [],
      templates: [],
      blank: initialState(),
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      strategies: [],
      runtimes: [],
      libraries: [],
      clients: CLIENT_OPTIONS.map((client) => ({
        id: client.value,
        label: client.label,
        carriers: carrierOptionsForClient(client.value).map((row) => [row.value, row.label]),
        accounts: [],
      })),
    };
    action.mockImplementation(async (name) => {
      if (name === 'membersRead') return structuredClone(metadata);
      if (name === 'memberCanonRead') return { bound: false, versions: [] };
      if (name === 'memberSave') return { id: 'codex', configurationRevision: 'saved' };
    });
    w.eval("go('member-codex')");
    await w.__settled();
    return env;
  }
  it('member more opens team or confirms the actual delete and preserves the editor on rejection', async () => {
    const { dom, w, action, data, port, errors } = await memberEditor();
    try {
      expect(declaredMenu(w, 'remove', '[data-view="page.member"] ')).toMatchObject([
        { act: 'open', data: { node: 'team', anchor: 'panel' } },
        { act: 'remove', data: { entity: 'member', id: 'codex' }, danger: true },
      ]);
      w.document.querySelector('[data-pop="menu"] [data-act="remove"]').click();
      expect(action.mock.calls.filter(([name]) => name === 'memberDelete')).toHaveLength(0);
      action.mockRejectedValueOnce(new Error('Member has an active owner'));
      await w.eval('dialogSubmit()');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Member has an active owner');
      expect(w.eval('S.route')).toBe('member');
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenCalledWith('memberDelete', { id: 'codex' }, undefined);
      expect(w.eval('S.route')).toBe('members');
      Object.assign(data.cats[0], { identityProtection: { kind: 'builtin-cloud' } });
      port.data = { ...port.data, chat: fixtureInput(data).chat };
      w.clowderChat.update(port);
      w.eval("go('member-codex')");
      await w.__settled();
      expect(declaredMenu(w, 'noop', '[data-view="page.member"] ')[1]).toMatchObject({ act: 'noop', danger: false });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('memberAvatar toggles the declared URL field and saves it through the member draft writer', async () => {
    const { dom, w, action, errors } = await memberEditor();
    try {
      declaredMenu(w, 'toggle', '#ms-identity ');
      w.document.querySelector('[data-pop="menu"] [data-path="ss.avPathOpen"]').click();
      const input = w.document.getElementById('f-avatarPath');
      expect(input).not.toBeNull();
      input.value = '/uploads/chosen-avatar.webp';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      expect(action.mock.calls.filter(([name]) => name === 'memberSave')).toHaveLength(0);
      await w.eval('FORMS.member()');
      expect(JSON.parse(action.mock.calls.find(([name]) => name === 'memberSave')![1].value)).toMatchObject({
        avatar: '/uploads/chosen-avatar.webp',
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
});
const mountRules = {
  version: 1,
  mountPoints: { codex: { path: '.codex/skills', enabled: true } },
  customPaths: [{ alias: 'custom', path: '.custom/skills' }],
};

describe('r8 missing settings binding families', () => {
  it('projects environment values from the held host push, keeps secrets masked and preserves a rejected edit', async () => {
    const { dom, w, port, get, post, action, errors } = await boot();
    const settings = {
      env: {
        categories: { server: 'Server', auth: 'Auth' },
        variables: [
          {
            name: 'PUBLIC_PORT',
            description: 'Public port',
            defaultValue: '3000',
            category: 'server',
            sensitive: false,
            currentValue: '3013',
            runtimeEditable: true,
            restartRequired: true,
          },
          {
            name: 'SECRET_KEY',
            description: 'Secret key',
            defaultValue: '',
            category: 'auth',
            sensitive: true,
            currentValue: '***',
            runtimeEditable: true,
          },
          {
            name: 'BOOT_ONLY',
            description: 'Bootstrap',
            defaultValue: 'on',
            category: 'server',
            sensitive: false,
            currentValue: null,
            runtimeEditable: false,
          },
        ],
      },
      envPending: [] as string[],
    };
    const read = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/config/env-summary' ? settings.env : read(name, params),
    );
    let reject = true;
    action.mockImplementation(async (name, args) => {
      if (name === 'settingsEnvSave') {
        if (reject) throw new Error('Environment owner rejected write');
        settings.env.variables[0].currentValue = args.value;
        settings.envPending = [args.key];
      }
      port.data = { ...port.data, project: { settings } };
      w.clowderChat.update(port);
      return true;
    });
    try {
      w.eval("go('env')");
      await w.__settled();
      expect(get).toHaveBeenCalledWith('/api/config/env-summary');
      expect(w.document.getElementById('sys-envedit').textContent).toContain('3013');
      const models = vi.spyOn(port, 'models');
      get.mockClear();
      post.mockClear();
      models.mockClear();
      expect(w.eval('VM.env().editable.map(function(v){return v.key})')).toEqual(['PUBLIC_PORT', 'SECRET_KEY']);
      expect(w.eval('VM.env().editable[1].secret')).toBe(true);
      expect(w.eval('VM.env().cats[0].count')).toBe(2);
      settings.env = {
        ...settings.env,
        variables: settings.env.variables.map((row, i) => (i === 0 ? { ...row, currentValue: '7777' } : row)),
      };
      expect(w.eval('VM.env().editable[0].value')).toBe('3013');
      expect(models).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      port.data = { ...port.data, project: { ...(port.data.project as object), settings: { ...settings } } };
      w.clowderChat.update(port);
      expect(w.eval('VM.env().editable[0].value')).toBe('7777');
      w.eval("A.envOpen({k:'PUBLIC_PORT'})");
      w.document.getElementById('env-in').value = '3014';
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenLastCalledWith('settingsEnvSave', { key: 'PUBLIC_PORT', value: '3014' });
      expect(w.document.querySelector('.dialog').textContent).toContain('Environment owner rejected write');
      expect(w.document.getElementById('env-in').value).toBe('3014');
      reject = false;
      await w.eval('dialogSubmit()');
      expect(w.eval('VM.env().editable[0].value')).toBe('3014');
      expect(w.eval('VM.env().pending')).toBe(1);
      w.eval("A.envOpen({k:'SECRET_KEY'})");
      expect(w.document.getElementById('env-in').value).toBe('');
      expect(w.eval('typeof VM.pcfCatalog')).toBe('undefined');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('restores the current real account in the member draft and waits for the existing member save owner', async () => {
    const { dom, w, data, action, port, post, errors } = await boot();
    Object.assign(data.cats[0], {
      accountRef: 'prior',
      accountBindingMode: 'override',
      configurationSource: 'managed_account',
    });
    const metadata = {
      accounts: [
        { id: 'prior', clientId: 'openai', displayName: 'Prior', authType: 'api_key', models: [] },
        { id: 'current', clientId: 'openai', displayName: 'Current', authType: 'api_key', models: [] },
      ],
      templates: [],
      blank: initialState(),
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      strategies: [],
      runtimes: [],
      libraries: [],
      clients: CLIENT_OPTIONS.map((c) => ({
        id: c.value,
        label: c.label,
        carriers: carrierOptionsForClient(c.value).map((v) => [v.value, v.label]),
        accounts: ['prior', 'current'],
      })),
    };
    action.mockImplementation(async (name) => {
      if (name === 'membersRead') return structuredClone(metadata);
      if (name === 'memberCanonRead') return { bound: false, versions: [] };
      if (name === 'settingsFollowRead') {
        port.data = {
          ...port.data,
          project: { settings: { follows: { openai: { state: 'selected', accountRef: 'current' } } } },
        };
        w.clowderChat.update(port);
        return true;
      }
      if (name === 'memberSave') return { id: 'codex', configurationRevision: 'next' };
    });
    try {
      port.data = { ...port.data, ...fixtureInput(data) };
      w.clowderChat.update(port);
      w.eval("go('member-codex')");
      await w.__settled();
      expect(w.document.querySelector('[data-act="followAcc"]')).not.toBeNull();
      await w.eval('A.followAcc()');
      expect(action).toHaveBeenCalledWith('settingsFollowRead', { clientId: 'openai' }, undefined);
      expect(w.document.querySelector('[data-k="acc"]').value).toBe('current');
      expect(action.mock.calls.filter(([name]) => name === 'memberSave')).toHaveLength(0);
      expect(post).not.toHaveBeenCalled();
      await w.eval('FORMS.member()');
      expect(JSON.parse(action.mock.calls.find(([name]) => name === 'memberSave')![1].value)).toMatchObject({
        accountRef: 'current',
        accountBindingMode: 'follow',
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('uses capSkillMount n/m to write exactly the requested project mount through the capability owner', async () => {
    const { dom, w, get, action, errors } = await boot(),
      original = get.getMockImplementation()!,
      board = capabilityData();
    get.mockImplementation(async (name, params) =>
      name === '/api/capabilities'
        ? board
        : name === '/api/skills'
          ? { skills: [] }
          : name === '/api/mount-rules'
            ? { rules: mountRules }
            : name.startsWith('/api/rules/skill/')
              ? { path: 'SKILL.md', content: 'Owner skill' }
              : original(name, params),
    );
    try {
      w.eval("S.project='/workspace/fixture';go('skill-0')");
      await w.__settled();
      w.eval("A.dialog({kind:'skillMounts'})");
      await w.__settled();
      expect(w.document.querySelector('[data-act="capSkillMount"][data-n="skill-one"][data-m="codex"]')).not.toBeNull();
      await w.eval("A.capSkillMount({n:'skill-one',m:'codex'})");
      expect(JSON.parse(action.mock.calls.find(([name]) => name === 'capabilitySave')![1].value)).toEqual({
        projectPath: '/workspace/fixture',
        capabilityId: 'skill-one',
        capabilityType: 'skill',
        source: 'cat-cafe',
        scope: 'project',
        enabled: false,
        mountPointId: 'codex',
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('starts a catalog installation on the click, shows it in progress on the install button and applies only the acknowledged host push', async () => {
    const plugin = {
      pluginId: 'fixture.plugin',
      displayName: 'Fixture plugin',
      publisher: 'Fixture publisher',
      source: { kind: 'catalog', catalogId: 'fixture.catalog' },
      availableVersion: '1.2.3',
      packageDigest: 'sha512-fixture',
      artifact: 'absent',
      intent: 'disabled',
      lifecycleRevision: 1,
      actions: { install: true },
      capabilitySummary: [{ kind: 'skill', name: 'Fixture skill' }],
    };
    const { dom, w, get, action, port, errors } = await boot([plugin]),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/plugin-manager/plugins/fixture.plugin'
        ? { plugin: { ...plugin, configFields: [] } }
        : original(name, params),
    );
    let reject = true;
    action.mockImplementation(async (name) => {
      if (name === 'settingsPluginInstall') {
        if (reject) throw new Error('Catalog quote changed');
        port.data = {
          ...port.data,
          project: { settings: { plugins: { plugins: [{ ...plugin, artifact: 'installed', intent: 'disabled' }] } } },
        };
        w.clowderChat.update(port);
        return true;
      }
    });
    try {
      w.eval("go('extItem-fixture.plugin')");
      await w.__settled();
      await w.eval("A.install({k:'fixture.plugin'})");
      expect(JSON.parse(action.mock.calls.find(([name]) => name === 'settingsPluginInstall')![1].value)).toEqual({
        source: { kind: 'catalog', catalogId: 'fixture.catalog' },
        expectedVersion: '1.2.3',
        expectedDigest: 'sha512-fixture',
      });
      expect(w.document.querySelector('.dialog')).toBeNull();
      expect(
        w.document.querySelector('[data-act="install"][data-k="fixture.plugin"][aria-busy="true"]'),
      ).not.toBeNull();
      await vi.waitFor(() => expect(w.document.body.textContent).toContain('Catalog quote changed'));
      expect(w.document.querySelector('[data-act="install"][aria-busy="true"]')).toBeNull();
      expect(w.eval('S.plugins["fixture.plugin"].installed')).toBe(false);
      reject = false;
      w.eval("A.install({k:'fixture.plugin'})");
      await w.eval('dialogSubmit()');
      await vi.waitFor(() => expect(w.eval('S.plugins["fixture.plugin"]')).toEqual({ installed: true, on: false }));
      expect(w.document.querySelector('.dialog')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('registers openUrl for real HTTP references and leaves demo links without a URL inert', async () => {
    const { dom, w, action, errors } = await boot();
    try {
      w.eval("A.openUrl({url:'https://example.test/evidence'});A.openUrl({url:'javascript:void(0)'});A.openUrl({})");
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('platform:openUrl', { url: 'https://example.test/evidence' }, undefined),
      );
      expect(action).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
});

describe('r136 setting owners through copied views', () => {
  it('keeps account preview tokens tied to the selected exception scope and retains owner rejection', async () => {
    const { dom, w, get, post, voiceState, errors } = await boot();
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/accounts'
        ? {
            providers: [
              {
                id: 'oauth-one',
                clientId: 'openai',
                displayName: 'Owner account',
                authType: 'oauth',
                codex: { status: 'ready', credentialHome: '/workspace/credentials' },
              },
            ],
          }
        : name.endsWith('/members')
          ? {
              selection: {
                state: 'selected',
                accountRef: 'other',
                members: [{ id: 'codex', name: 'Codex', accountRef: 'other' }],
              },
            }
          : original(name, params),
    );
    post.mockImplementation(async (name, _params, body) => {
      if (name.endsWith('/preview'))
        return {
          previewToken: (body as { includeOverrides: boolean }).includeOverrides ? 'second-token' : 'first-token',
          targets: [{ catId: 'codex', name: 'Codex' }],
          exceptions: [],
        };
      throw new Error('Account selection changed');
    });
    try {
      w.eval("go('accounts')");
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.accounts"]')?.textContent).toContain('Owner account');
      await w.eval("A.set({path:'ss.termEdit',v:2})");
      expect(voiceState.termEdit).toBe(2);
      await w.eval("A.accSwitch({k:'oauth-one'})");
      expect(post).toHaveBeenLastCalledWith(
        '/api/accounts/oauth-one/codex/binding/preview',
        {},
        { scope: 'local', includeOverrides: false },
      );
      await w.eval("A.toggle({path:'ss.accountSwitch.includeOverrides'})");
      expect(w.eval('VM.accountSwitch().includeOverrides')).toBe(true);
      await w.eval("A.accSwitchOk({k:'oauth-one'})");
      expect(post).toHaveBeenLastCalledWith(
        '/api/accounts/oauth-one/codex/binding/commit',
        {},
        { scope: 'local', includeOverrides: true, previewToken: 'second-token' },
      );
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Account selection changed');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('dispatches login confirmation, cancellation and conflict decisions with the actual attempt id', async () => {
    const { dom, w, get, post } = await boot(),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/accounts'
        ? {
            providers: [
              {
                id: 'oauth-one',
                clientId: 'openai',
                displayName: 'Account',
                authType: 'oauth',
                codex: { credentialHome: '/workspace/credentials', attempt: { id: 'attempt-one', state: 'review' } },
              },
            ],
          }
        : name.endsWith('/members')
          ? { selection: { state: 'empty', members: [] } }
          : original(name, params),
    );
    try {
      w.eval("go('accounts')");
      await w.__settled();
      expect(post).not.toHaveBeenCalled();
      await w.eval("A.accLogin({k:'oauth-one',v:'go'})");
      expect(post).toHaveBeenLastCalledWith(
        '/api/accounts/oauth-one/codex/login/confirm',
        {},
        { attemptId: 'attempt-one' },
      );
      await w.eval("A.accLogin({k:'oauth-one',v:'cancel'})");
      expect(post).toHaveBeenLastCalledWith(
        '/api/accounts/oauth-one/codex/login/cancel',
        {},
        { attemptId: 'attempt-one' },
      );
      await w.eval("A.accConflict({k:'oauth-one',v:'keep'})");
      expect(post).toHaveBeenLastCalledWith(
        '/api/accounts/oauth-one/codex/login/create-new',
        {},
        { attemptId: 'attempt-one' },
      );
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('leaves a failed bootstrap result on its own client-library record and performs no writes while drawing', async () => {
    const { dom, w, post, errors } = await boot();
    try {
      w.eval(
        "PCF_SRC['client-check']={plugin:'client-plugin',installed:true,clientLibraries:[{configurationKey:'profiles'}],fields:[{key:'profiles',kind:'records',label:'Profiles',currentValue:JSON.stringify([{id:'first',bootstrapRoot:'/workspace/one'},{id:'second',bootstrapRoot:'/workspace/two'}]),recordFields:[]}]}; pcfModel('client-check',PCF_SRC['client-check']); render(true)",
      );
      expect(post).not.toHaveBeenCalled();
      post.mockResolvedValue({ ok: false, error: 'Directory is not bootstrapped' });
      await w.eval("A.pcfOp({p:'client-check',k:'profiles',i:'1',op:'recCheck'})");
      expect(post).toHaveBeenLastCalledWith('/api/agent-providers/bootstrap-check', {}, { root: '/workspace/two' });
      expect(w.eval("pcfState('client-check').checks['profiles#second']")).toEqual({
        ok: false,
        error: 'Directory is not bootstrapped',
      });
      expect(w.eval("pcfState('client-check').checks['profiles#first']")).toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens the canon avatar dialog with real versions, requires a reason and keeps the selection after an owner rejection', async () => {
    const { dom, w, action, errors } = await boot();
    const canon = {
      bound: true,
      avatar: '/api/cats/codex/avatar?bindingRevision=2',
      current: 'current-version',
      bindingRevision: 2,
      versions: [
        {
          id: 'old-version',
          label: 'Old avatar',
          assetRevision: 3,
          at: '2026-01-01',
          supersededReason: 'Approved identity update',
        },
        { id: 'current-version', label: 'Current avatar', assetRevision: 4, at: '2026-02-01', supersededReason: '' },
      ],
    };
    const metadata = {
      accounts: [],
      templates: [],
      blank: initialState(),
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      strategies: [],
      runtimes: [],
      libraries: [],
      clients: CLIENT_OPTIONS.map((client) => ({
        id: client.value,
        label: client.label,
        carriers: carrierOptionsForClient(client.value).map((row) => [row.value, row.label]),
        accounts: [],
      })),
    };
    action.mockImplementation(async (name) => {
      if (name === 'membersRead') return structuredClone(metadata);
      if (name === 'memberCanonRead') return canon;
      if (name === 'memberCanonSave') throw new Error('Avatar owner changed');
    });
    try {
      w.eval("go('member-codex')");
      await w.__settled();
      expect(w.document.querySelector('[data-kind="canonAvatar"]')).not.toBeNull();
      expect(w.document.querySelector('#mform .ava-up input[type="file"]')).toBeNull();
      expect(action.mock.calls.filter((c) => c[0] === 'memberCanonSave')).toHaveLength(0);
      w.eval("A.canonAvatarOpen({id:'codex'})");
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Approved identity update');
      await w.eval('dialogSubmit()');
      expect(action.mock.calls.filter((c) => c[0] === 'memberCanonSave')).toHaveLength(0);
      w.document.getElementById('dlg-in').value = 'Human reviewed identity';
      await w.eval('dialogSubmit()');
      const write = action.mock.calls.find((c) => c[0] === 'memberCanonSave')!;
      expect(JSON.parse(write[1].value)).toMatchObject({
        expectedBindingRevision: 2,
        expectedAssetRevision: 4,
        indexedVersionRef: 'current-version',
        reason: 'Human reviewed identity',
      });
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Avatar owner changed');
      expect(w.document.querySelector('input[name="canon-v"]:checked').value).toBe('current-version');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('keeps a member switch tied to that member while the previous canon read is pending', async () => {
    const { dom, w, action, data, errors } = await boot();
    data.cats.push({ ...data.cats[0], id: 'peer' } as (typeof data.cats)[number]);
    const metadata = {
      accounts: [],
      templates: [],
      blank: initialState(),
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      strategies: [],
      runtimes: [],
      libraries: [],
      clients: CLIENT_OPTIONS.map((client) => ({
        id: client.value,
        label: client.label,
        carriers: carrierOptionsForClient(client.value).map((row) => [row.value, row.label]),
        accounts: [],
      })),
    };
    const canon = (id: string) => ({
      bound: true,
      current: id,
      bindingRevision: 1,
      versions: [{ id: id, label: id + ' avatar', assetRevision: 1, at: '2026-01-01', supersededReason: '' }],
    });
    let finish!: (value: unknown) => void;
    action.mockImplementation(async (name, args) => {
      if (name === 'membersRead') return structuredClone(metadata);
      if (name === 'memberCanonRead')
        return args.id === 'codex'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : canon(args.id);
    });
    try {
      w.eval("go('member-codex')");
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      w.eval("go('member-peer')");
      finish(canon('codex'));
      await w.__settled();
      expect(action).toHaveBeenLastCalledWith('memberCanonRead', { id: 'peer' }, undefined);
      w.eval("A.canonAvatarOpen({id:'peer'})");
      expect(w.document.querySelector('.dialog')?.textContent).toContain('peer avatar');
      expect(w.document.querySelector('.dialog')?.textContent).not.toContain('codex avatar');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('reads model dossiers and observations, and refreshes the original observation owner after confirmation', async () => {
    const { dom, w, get, post, errors } = await boot(),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/dossier'
        ? {
            meta: { dossierCoverage: 1, totalCats: 1, totalModels: 1 },
            modelGroups: [
              {
                model: 'owner-model',
                cats: [
                  {
                    catId: 'codex',
                    runtime: 'openai',
                    dossier: {
                      oneLiner: 'Owner capability',
                      l0RosterSummary: 'Actual summary',
                      routingSignals: { peakCapabilities: ['Review'], antiSignals: ['Rendering'] },
                    },
                  },
                ],
              },
            ],
          }
        : name === '/api/dossier/observations'
          ? { observations: { codex: [{ content: 'Owner observation', createdAt: 1, author: 'Operator' }] } }
          : original(name, params),
    );
    try {
      w.eval("go('profiles')");
      await w.__settled();
      expect(w.eval('VM.profiles().models[0].cats[0].body.obs[0].t')).toBe('Owner observation');
      expect(post).not.toHaveBeenCalled();
      w.eval("A.profObs({id:'codex'})");
      w.document.getElementById('obs-in').value = 'New human observation';
      await w.eval('dialogSubmit()');
      expect(post).toHaveBeenLastCalledWith(
        '/api/dossier/observations',
        {},
        { catId: 'codex', content: 'New human observation' },
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('uses project and per-member MCP scopes, real mount rules and read-only skill content', async () => {
    const { dom, w, get, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    const capabilities = capabilityData();
    Object.assign(capabilities.items[0], {
      requiresMcp: [
        { id: 'playwright', status: 'ready' },
        { id: 'claude-in-chrome', status: 'missing' },
        { id: 'agent-browser', status: 'missing' },
        { id: 'pinchtab', status: 'unresolved' },
      ],
    });
    get.mockImplementation(async (name, params) =>
      name === '/api/capabilities'
        ? capabilities
        : name === '/api/skills'
          ? { skills: [] }
          : name === '/api/mount-rules'
            ? { rules: structuredClone(mountRules) }
            : name.startsWith('/api/rules/skill/')
              ? { path: 'skills/skill-one/SKILL.md', content: '# Owner skill' }
              : original(name, params),
    );
    try {
      w.eval("go('skills')");
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.skills"]')?.textContent).toContain('Actual skill');
      await w.eval("CHANGES.capProject({target:{value:'/workspace/fixture'}})");
      await w.__settled();
      await w.eval("A.setStatus({entity:'mcpCat',id:'mcp-one|codex',v:'false'})");
      expect(JSON.parse(action.mock.calls.find((c) => c[0] === 'capabilitySave')![1].value)).toEqual({
        capabilityId: 'mcp-one',
        capabilityType: 'mcp',
        source: 'external',
        projectPath: '/workspace/fixture',
        scope: 'project',
        catId: 'codex',
        mountPointId: 'codex',
        enabled: false,
      });
      w.eval("go('skill-0')");
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.skill"]')?.textContent).toContain('Owner skill');
      expect(w.eval('VM.skill().issues.dep')).toEqual([
        {
          code: 'dep',
          n: 3,
          missing: true,
          deps: [
            { id: 'claude-in-chrome', st: 'missing' },
            { id: 'agent-browser', st: 'missing' },
            { id: 'pinchtab', st: 'unresolved' },
          ],
        },
      ]);
      const skillBody = w.document.querySelector('[data-view="page.skill"]').textContent;
      expect(skillBody).toContain('claude-in-chrome');
      expect(skillBody).toContain('agent-browser');
      expect(skillBody.match(/缺少依赖。/g)).toHaveLength(1);
      w.eval("A.dialog({kind:'skillMounts'})");
      expect(w.document.querySelector('.dialog')?.textContent).toContain('.custom/skills/skill-one');
      await w.eval("A.setStatus({entity:'skillMount',id:'custom',v:'true'})");
      expect(JSON.parse(action.mock.calls.filter((c) => c[0] === 'capabilitySave').at(-1)![1].value)).toMatchObject({
        scope: 'project',
        mountPointId: 'custom',
        projectPath: '/workspace/fixture',
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('keeps MCP drafts dirty by comparing values, previews before install and reads saved secrets only at the owner', async () => {
    const { dom, w, get, post, errors } = await boot(),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/capabilities'
        ? capabilityData()
        : name === '/api/skills'
          ? { skills: [] }
          : name === '/api/mount-rules'
            ? { rules: mountRules }
            : original(name, params),
    );
    post.mockImplementation(async (name) =>
      name.endsWith('/tools')
        ? { connectionStatus: 'connected', tools: [{ name: 'owner-tool', description: 'Actual tool' }] }
        : { entry: { id: 'new-mcp' } },
    );
    try {
      w.eval("go('mcpItem-0')");
      await w.__settled();
      expect(w.eval('S.dirty')).toBe(false);
      await w.eval('A.mcpProbe()');
      expect(post).toHaveBeenLastCalledWith('/api/mcp/mcp-one/tools', {}, {});
      expect(w.document.querySelector('[data-view="page.mcpItem"]')?.textContent).toContain('owner-tool');
      w.eval("go('mcpNew')");
      await w.__settled();
      w.document.getElementById('m-name').value = 'new-mcp';
      w.document.getElementById('m-name').dispatchEvent(new w.Event('input', { bubbles: true }));
      w.document.getElementById('m-cmd').value = 'node';
      w.document.getElementById('m-cmd').dispatchEvent(new w.Event('input', { bubbles: true }));
      expect(w.eval('S.dirty')).toBe(true);
      await w.eval('A.mcpPreview()');
      expect(post.mock.calls.at(-1)![0]).toBe('/api/capabilities/mcp/preview');
      await w.eval('FORMS.mcp()');
      expect(post.mock.calls.at(-1)![0]).toBe('/api/capabilities/mcp/install');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('reads the rule manifest and segment, preserves a rejected edit and dispatches reset/restore to the existing owners', async () => {
    const { dom, w, get, post, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    const file = { path: 'rules.md', exists: true, content: 'Owner rules', consumption: { label: 'actual' } };
    get.mockImplementation(async (name, params) =>
      name === '/api/rules'
        ? { sharedRules: [file], providerGuides: [], l0Prompts: { template: file } }
        : name === '/api/prompt-injection/manifest'
          ? {
              segments: [
                {
                  id: 'D1',
                  name: 'Identity',
                  lifecycleStage: 'session-init',
                  sourceType: 'template',
                  source: 'identity.md',
                  allowLocalOverride: true,
                  userExplanation: 'Actual segment',
                },
                {
                  id: 'M1',
                  name: 'Mission',
                  lifecycleStage: 'per-turn',
                  sourceType: 'observe-only',
                  source: 'invoke.ts',
                  allowLocalOverride: false,
                  userExplanation: 'Mission context',
                },
              ],
            }
          : name.endsWith('/D1/content')
            ? {
                segmentId: 'D1',
                allowLocalOverride: true,
                content: 'Original template',
                hasOverride: true,
                hasBackup: true,
              }
            : original(name, params),
    );
    action.mockImplementation(async () => {
      throw new Error('Template rejected');
    });
    try {
      w.eval("go('rules'); S.lifeOpen=1; render(true)");
      await w.__settled();
      expect(w.eval('VM.rules().stage.groups[0].items[0].sub')).toBe('Actual segment');
      expect(w.eval('VM.rules().stage.groups[0].items[0]')).toMatchObject({
        kind: 'edit',
        viewable: true,
        editable: true,
      });
      expect(get.mock.calls.filter(([name]) => name.endsWith('/D1/content'))).toHaveLength(0);
      w.eval("A.fold({path:'s.lifeOpen',v:2}); A.fold({path:'ss.lifeItem',v:'M1'});");
      expect(w.eval('VM.rules().stage.groups[0].items[0]')).toMatchObject({
        id: 'M1',
        selected: true,
        viewable: false,
      });
      w.eval("A.segOpen({id:'D1'})");
      await w.__settled();
      expect(w.document.querySelector('.dialog').textContent).toContain('D1 Identity');
      expect(get.mock.calls.filter(([name]) => name.endsWith('/D1/content'))).toHaveLength(1);
      w.document.getElementById('seg-text').value = 'User template';
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenLastCalledWith('segmentSave', { id: 'D1', value: 'User template' });
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Template rejected');
      expect(w.document.getElementById('seg-text').value).toBe('User template');
      action.mockResolvedValue({});
      await w.eval("A.reset({scope:'seg.def.D1'})");
      expect(action).toHaveBeenLastCalledWith('segmentReset', { id: 'D1' });
      await w.eval("A.reset({scope:'seg.bak.D1'})");
      expect(post).toHaveBeenLastCalledWith('/api/prompt-injection/segment/D1/restore-backup', {}, {});
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens the declared guide window, replays through its owner and hands off to the existing native setup', async () => {
    const { dom, w, action, post, errors } = await boot();
    action.mockImplementation(async (name) => (name === 'nativeDetect' ? [] : undefined));
    const replay = {
      load: '',
      thread: null,
      source: 'guide',
      storyId: null,
      typingMs: null,
      engine: {
        state: 'paused',
        currentIndex: 0,
        speed: 1,
        adaptivePacing: true,
        displayMode: 'cinematic',
        elapsedMs: 0,
        totalDurationMs: 0,
      },
      events: [],
      eventTimes: [],
      messages: [],
      chapters: [],
      features: [],
      guideScript: [],
      guideTeam: {},
      guideLanguage: 'zh',
      guideHtml: '<!doctype html><title>Bundled demo</title>',
      annotations: { storyId: null, load: '', value: null, error: '' },
    };
    w.clowderChat.pushProject({ replay });
    try {
      w.eval("A.open({ref:'guide'})");
      await w.__settled();
      expect(w.document.querySelector('[data-pop="guide"]')).not.toBeNull();
      expect(action.mock.calls.some((c) => c[0] === 'guideOpen')).toBe(true);
      await w.eval('A.guideReplay()');
      expect(action).toHaveBeenLastCalledWith('guideOpen', { language: 'zh' }, undefined);
      w.eval("A.set({path:'s.popOn.guide|s.popOn.nativeSetup',v:'false|true',cast:'bool'})");
      await w.__settled();
      expect(w.eval('S.popOn.guide')).toBe(false);
      expect(w.eval('S.popOn.nativeSetup')).toBe(true);
      expect(w.document.querySelector('[data-pop="guide"]')).toBeNull();
      expect(post).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('lists and verifies local sessions without importing, then waits for the existing admission owner', async () => {
    const { dom, w, get, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    const session = {
      sessionId: 'session-one',
      projectPath: '/workspace/fixture',
      firstPrompt: 'Actual first prompt',
      lastActivityAt: 1,
      alreadyBound: false,
    };
    get.mockImplementation(async (name, params) =>
      name === '/api/local-sessions/codex'
        ? { sessions: [session] }
        : name === '/api/local-sessions/codex/session-one'
          ? { session }
          : original(name, params),
    );
    try {
      w.eval("go('home')");
      await w.__settled();
      action.mockClear();
      w.document.querySelector('[data-act="modal"][data-v="import"]').click();
      await w.__settled();
      expect(w.document.querySelector('[data-pop="chat.modal"]')?.textContent).toContain('Actual first prompt');
      expect(action).not.toHaveBeenCalled();
      await w.eval("A.cafeImVerify({v:'session-one'})");
      expect(w.eval('CS.modal.sel')).toBe('session-one');
      expect(action).not.toHaveBeenCalled();
      action.mockRejectedValue(new Error('Session has an active writer'));
      await w.eval('FORMS.cafeModal()');
      expect(action).toHaveBeenLastCalledWith('sessionImport', {
        value: JSON.stringify({
          catId: 'codex',
          sessionId: 'session-one',
          projectPath: '/workspace/fixture',
          firstPrompt: 'Actual first prompt',
        }),
        title: '',
        pinned: 'false',
      });
      expect(w.document.querySelector('[data-pop="chat.modal"]')?.textContent).toContain(
        'Session has an active writer',
      );
      expect(w.eval('CS.modal.verify.sessionId')).toBe('session-one');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('browses actual directory entries and drive roots and creates a folder only on explicit confirmation', async () => {
    const { dom, w, get, post, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/projects/browse'
        ? { current: '/workspace', entries: [{ name: 'fixture', path: '/workspace/fixture' }] }
        : name === '/api/projects/drives'
          ? { drives: [{ label: 'Data', path: '/data' }] }
          : original(name, params),
    );
    post.mockResolvedValue({ createdPath: '/workspace/new' });
    const picker = {
      browse: null as unknown,
      directories: {} as Record<string, unknown>,
      drives: [] as unknown[],
      completions: { prefix: '', entries: [] },
      setup: {} as Record<string, unknown>,
    };
    const bench = { ...fixtureWorkbenchSource(), projectPicker: picker };
    action.mockImplementation(async (name, args) => {
      if (name === 'cafeProjectPrepare') {
        picker.setup[args.path] = {
          load: '',
          directory: { isEmptyDir: true, isGitRepo: false, gitAvailable: true },
          index: { status: 'missing', snoozed_until: null, error_message: null },
        };
        w.clowderChat.pushProject({ workbench: bench });
        return true;
      }
      if (name === 'projectBrowse') {
        const directory = (await get('/api/projects/browse', args.path ? { path: args.path } : {})) as {
          current: string;
        };
        picker.browse = directory;
        picker.directories[directory.current] = directory;
        picker.drives = ((await get('/api/projects/drives')) as { drives: unknown[] }).drives;
        w.clowderChat.pushProject({ workbench: bench });
        return { directory };
      }
      if (name === 'projectMkdir') {
        const receipt = await post('/api/projects/mkdir', {}, { parentPath: args.path, name: args.name });
        const directory = (await get('/api/projects/browse', { path: args.path })) as { current: string };
        picker.directories[directory.current] = directory;
        w.clowderChat.pushProject({ workbench: bench });
        return receipt;
      }
    });
    w.clowderChat.pushProject({ workbench: bench });
    try {
      w.eval("CS.pop={kind:'projPick'}; render(true)");
      await w.eval("A.popPage({ v:'browse'})");
      await w.__settled();
      expect(w.document.querySelector('[data-view="chat.pop"]')?.textContent).toContain('fixture');
      expect(w.document.querySelector('[data-view="chat.pop"]')?.textContent).toContain('Data');
      expect(post).not.toHaveBeenCalled();
      expect(action).toHaveBeenCalledWith('projectBrowse', { path: '' }, undefined);
      w.eval("A.dialog({kind:'dirNew',p:'/workspace'})");
      w.document.getElementById('dlg-in').value = 'new';
      await w.eval('dialogSubmit()');
      expect(post).toHaveBeenLastCalledWith('/api/projects/mkdir', {}, { parentPath: '/workspace', name: 'new' });
      expect(w.eval('CS.ppPick')).toBe('/workspace/new');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('shows only accessible origins for already-bound local sessions and leaves them out of import choices', async () => {
    const { dom, w, get, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/local-sessions/codex'
        ? {
            sessions: [
              { sessionId: 'private', firstPrompt: 'Private origin', alreadyBound: true },
              {
                sessionId: 'visible',
                firstPrompt: 'Visible origin',
                alreadyBound: true,
                boundThread: { id: 'visible-thread', title: 'Source title' },
              },
            ],
          }
        : original(name, params),
    );
    try {
      await w.eval("A.modal({ v:'import'})");
      await w.__settled();
      const modal = w.document.querySelector('[data-pop="chat.modal"]');
      expect(modal.textContent).toContain('Private origin');
      expect(modal.querySelectorAll('[data-act="threadOpen"]')).toHaveLength(1);
      expect(modal.querySelector('[data-act="threadOpen"]').dataset.id).toBe('visible-thread');
      expect(w.eval('VM.chatModal().data.sessions.map(function(s){return s.alreadyBound})')).toEqual([true, true]);
      expect(action).not.toHaveBeenCalled();
      modal.querySelector('[data-act="threadOpen"]').click();
      await w.__settled();
      expect(action).toHaveBeenCalledWith('thread', expect.objectContaining({ id: 'visible-thread' }), undefined);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('reads real push diagnostics and writes subscriptions, tests and nonempty VAPID drafts only on explicit actions', async () => {
    const { dom, w, get, post, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    const status = {
        capability: { enabled: true, vapidPublicKeyConfigured: true, pushServiceConfigured: true },
        subscription: { count: 0, targets: [] as { endpoint: string; uaFamily: string }[] },
        delivery: {
          lastResult: 'not_attempted',
          lastAttemptAt: null as number | null,
          lastHttpStatus: null as number | null,
          lastError: null as string | null,
        },
        errorHints: [] as string[],
      },
      client = { isSupported: true, permission: 'granted', isSubscribed: false, worker: 'registered' };
    get.mockImplementation(async (name, params) =>
      name === '/api/push/status'
        ? status
        : name === '/api/config/env-summary'
          ? {
              ...environmentSummaryFixture(),
              variables: [
                ...systemSummaryFixture().variables,
                {
                  name: 'F102_API_KEY',
                  currentValue: null,
                  defaultValue: '(unset)',
                  category: 'evidence',
                  sensitive: true,
                  description: 'Evidence API credential',
                  runtimeEditable: true,
                },
              ],
            }
          : original(name, params),
    );
    action.mockImplementation(async (name) => {
      if (name === 'pushClientRead') return { ...client };
      client.isSubscribed = name === 'pushSubscribe';
      status.subscription = {
        count: client.isSubscribed ? 1 : 0,
        targets: client.isSubscribed ? [{ endpoint: 'push.example/…fixture', uaFamily: 'Chromium' }] : [],
      };
    });
    let saveFails = true;
    post.mockImplementation(async (name) => {
      if (name === '/api/push/generate-vapid')
        return { publicKey: 'draft-public-key', privateKey: 'draft-private-key' };
      if (name === '/api/config/secrets') {
        if (saveFails) throw new Error('Host credential writes can only be modified by the configured owner');
        return { ok: true };
      }
      if (name === '/api/push/test') {
        status.delivery = {
          lastResult: 'error',
          lastAttemptAt: 1793664000000,
          lastHttpStatus: 502,
          lastError: 'push_delivery_failed',
        };
        status.errorHints = ['push_last_delivery_failed'];
        throw new Error('Delivery rejected');
      }
      throw new Error('Unexpected write: ' + name);
    });
    try {
      w.eval("go('system')");
      await w.__settled();
      expect(post).not.toHaveBeenCalled();
      expect(action.mock.calls.map(([name]) => name)).toEqual(['pushClientRead']);
      expect(get.mock.calls.filter(([name]) => name === '/api/config/env-summary?surface=system')).toHaveLength(1);
      expect(get.mock.calls.filter(([name]) => name === '/api/config/env-summary')).toHaveLength(1);
      expect(w.eval('VM.system().envCount')).toBe(2);
      expect(w.document.getElementById('sys-network').textContent).toContain('4014');
      expect(w.document.getElementById('sys-storage').textContent).toContain('/fixture/uploads');
      expect(w.document.getElementById('sys-ttl')).not.toBeNull();
      expect(w.eval('VM.system().env')).toMatchObject({
        apiPort: '4014',
        previewPort: '4111',
        listenAddr: '127.0.0.1',
        frontendUrl: 'https://console.test',
        frontendPort: '4013',
        transcriptDir: '/fixture/transcripts',
        logDir: '/fixture/runtime-logs',
        allowedDirs: '/fixture',
        allowedDirsAppend: '(unset)',
        deniedDirs: '/fixture/private',
        ownerUserId: 'fixture-owner',
      });
      expect(w.eval('VM.system().v')).toMatchObject({
        lan: false,
        preview: true,
        memFallback: false,
        ttlMsg: '604800',
        ttlThread: '0',
        ttlTask: '604800',
        logLevel: 'info',
        timeout: '60000',
      });
      expect(w.eval('VM.system().paths')).toEqual(environmentSummaryFixture().paths);
      expect(
        w.eval('VM.system().config.variables.find(function(v){return v.name==="MESSAGE_TTL_SECONDS"})'),
      ).toMatchObject({
        currentValue: '604800',
        runtimeEditable: false,
      });
      expect(w.document.querySelectorAll('[data-act="pushToggle"]')).toHaveLength(1);
      expect(w.eval('VM.system().notifyTypes')).toEqual([]);
      w.eval("A.dialog({kind:'push'})");
      await w.__settled();
      expect(w.document.querySelector('[data-view="dialog.push"]')).not.toBeNull();
      expect(w.document.querySelector('[data-act="pushTest"]')).toBeNull();
      expect(post).not.toHaveBeenCalled();
      await w.eval('A.pushToggle()');
      expect(action).toHaveBeenCalledWith('pushSubscribe', {});
      expect(w.eval('VM.pushDiag().subscribed')).toBe(true);
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Chromium');
      expect(w.document.querySelector('[data-act="pushTest"]')).not.toBeNull();
      await w.eval('A.pushTest()');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('502');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('push_delivery_failed');
      expect(w.eval('VM.pushDiag().result.message')).toBe('Delivery rejected');
      expect(w.document.querySelector('.dialog')?.textContent.match(/Delivery rejected/g)).toHaveLength(1);
      await w.eval('A.vapidGen()');
      expect(w.document.getElementById('vp-pub').value).toBe('draft-public-key');
      expect(w.document.getElementById('vp-priv').value).toBe('draft-private-key');
      expect(w.document.querySelector('.dialog')?.textContent).toContain(
        w.eval("tc('system.pushConfiguration.generated')"),
      );
      expect(post.mock.calls.filter(([name]) => name === '/api/config/secrets')).toHaveLength(0);
      await w.eval('A.vapidSave()');
      expect(post).toHaveBeenLastCalledWith(
        '/api/config/secrets',
        {},
        {
          updates: [
            { name: 'VAPID_PUBLIC_KEY', value: 'draft-public-key' },
            { name: 'VAPID_PRIVATE_KEY', value: 'draft-private-key' },
          ],
        },
      );
      expect(w.document.getElementById('vp-priv').value).toBe('draft-private-key');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('configured owner');
      saveFails = false;
      await w.eval('A.vapidSave()');
      expect(w.document.getElementById('vp-priv').value).toBe('');
      expect(w.eval('VM.pushDiag().result.kind')).toBe('saved');
      expect(w.document.querySelector('.dialog')?.textContent).toContain(
        w.eval("tc('settings.notifications.pushSaved')"),
      );
      expect(w.document.querySelector('[data-act="vapidSave"]')).toBeNull();
      await w.eval('A.pushToggle()');
      expect(action).toHaveBeenCalledWith('pushUnsubscribe', {});
      expect(w.eval('VM.pushDiag().subscribed')).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('shows push retirement and server errors without presenting an unavailable subscription switch', async () => {
    const { dom, w, get, action, post, errors } = await boot(),
      original = get.getMockImplementation()!;
    get.mockImplementation(async (name, params) =>
      name === '/api/push/status'
        ? {
            capability: { enabled: false, vapidPublicKeyConfigured: false, pushServiceConfigured: false },
            subscription: { count: 0, targets: [] },
            delivery: { lastResult: 'not_attempted', lastAttemptAt: null, lastHttpStatus: null, lastError: null },
            errorHints: ['push_vapid_key_missing', 'push_not_configured', 'push_subscription_missing'],
          }
        : original(name, params),
    );
    action.mockResolvedValue({ isSupported: false, permission: 'default', isSubscribed: false, worker: 'disabled' });
    try {
      w.eval("go('system')");
      await w.__settled();
      expect(w.document.querySelector('[data-act="pushToggle"]')).toBeNull();
      expect(w.eval('VM.system().push.capability.enabled')).toBe(false);
      w.eval("A.dialog({kind:'push'})");
      await w.__settled();
      expect(w.eval('VM.pushDiag().errorHints')).toEqual([
        { code: 'push_vapid_key_missing' },
        { code: 'push_not_configured' },
        { code: 'push_subscription_missing' },
      ]);
      expect(w.document.querySelector('[data-act="pushSubscribe"]')).toBeNull();
      expect(w.document.querySelector('[data-act="pushTest"]')).toBeNull();
      expect(post).not.toHaveBeenCalled();
      expect(action.mock.calls.every(([name]) => name === 'pushClientRead')).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('projects native and goal observations, and targets effort/speed writes at the opened thread', async () => {
    const { dom, w, get, post, action, data, errors } = await boot(),
      original = get.getMockImplementation()!;
    const id = data.threads[0].id;
    data.cats.push({ ...data.cats[0], id: 'opus', displayName: 'Opus' });
    const effort = {
      catId: 'codex',
      displayName: 'Codex',
      isParticipant: true,
      override: null,
      options: ['low', 'medium', 'high', 'xhigh'],
      inherited: 'high',
      effective: 'high',
    };
    const speed = {
      catId: 'codex',
      displayName: 'Codex',
      isParticipant: true,
      override: null,
      requested: 'standard',
      options: ['standard', 'fast'],
    };
    get.mockImplementation(async (name, params) =>
      name.endsWith('/goal')
        ? {
            goal: { objective: 'Owner objective', status: 'active', tokenBudget: null, sync: { state: 'synced' } },
            nativeTargets: [{ catId: 'codex' }, { catId: 'opus' }],
          }
        : name.endsWith('/native-status')
          ? {
              statuses: [
                {
                  catId: 'codex',
                  observation: 'available',
                  capabilities: {
                    availability: 'available',
                    imageGeneration: false,
                    namespaceTools: true,
                    webSearch: true,
                  },
                  permissionProfiles: { availability: 'unavailable', reason: 'invalid_response' },
                  account: { availability: 'available', authenticated: true, kind: 'chatgpt', plan: 'pro' },
                  rateLimits: { availability: 'available', primary: { usedPercent: 12, resetsAt: null } },
                },
              ],
            }
          : name.endsWith('/members/effort')
            ? {
                members: [
                  effort,
                  { ...effort, catId: 'opus', displayName: 'Opus', options: ['high', 'max'], override: 'max' },
                ],
              }
            : name.endsWith('/members/speed')
              ? {
                  members: [
                    speed,
                    { ...speed, catId: 'opus', displayName: 'Opus', options: ['standard'], override: 'standard' },
                  ],
                }
              : original(name, params),
    );
    try {
      declaredMenu(w, 'modal', '[data-view="nav.threads"] ');
      w.document.querySelector('[data-pop="menu"] [data-v="tset"]').click();
      await w.__settled();
      for (const endpoint of ['goal', 'native-status', 'members/effort', 'members/speed'])
        expect(get).toHaveBeenCalledWith('/api/threads/' + id + '/' + endpoint, undefined);
      expect(action).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(w.eval('VM.chatModal().data.runtime.statuses[0]')).toMatchObject({
        catId: 'codex',
        account: { kind: 'chatgpt' },
        rateLimits: { primary: { usedPercent: 12 } },
        capabilities: { imageGeneration: false },
        permissionProfiles: { reason: 'invalid_response' },
      });
      w.eval("CS.modal.open='think';render(true)");
      expect(Array.from(w.document.getElementById('ts-th-codex').options, (o: HTMLOptionElement) => o.value)).toEqual([
        '',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
      expect(Array.from(w.document.getElementById('ts-th-opus').options, (o: HTMLOptionElement) => o.value)).toEqual([
        '',
        'high',
        'max',
      ]);
      expect(w.document.getElementById('ts-th-opus').value).toBe('max');
      await w.eval("CHANGES.cafeTsThink({target:{dataset:{catId:'opus'},value:''}})");
      expect(action).toHaveBeenLastCalledWith('threadEffortSave', { threadId: id, id: 'opus', value: '' });
      w.eval("CS.modal.open='speed';render(true)");
      expect(Array.from(w.document.getElementById('ts-speed-opus').options, (o: HTMLOptionElement) => o.value)).toEqual(
        ['', 'standard'],
      );
      await w.eval("CHANGES.cafeTsSpeed({target:{dataset:{catId:'opus'},value:''}})");
      expect(action).toHaveBeenLastCalledWith('threadSpeedSave', { threadId: id, id: 'opus', value: '' });
      w.eval("CS.modal.open='goal';render(true)");
      expect(Array.from(w.document.getElementById('ts-goal-cat').options, (o: HTMLOptionElement) => o.value)).toEqual([
        'codex',
        'opus',
      ]);
      await w.eval("CHANGES.cafeTsThink({target:{dataset:{catId:'codex'},value:'medium'}})");
      expect(action).toHaveBeenLastCalledWith('threadEffortSave', { threadId: id, id: 'codex', value: 'medium' });
      await w.eval("CHANGES.cafeTsSpeed({target:{dataset:{catId:'codex'},value:'fast'}})");
      expect(action).toHaveBeenLastCalledWith('threadSpeedSave', { threadId: id, id: 'codex', value: 'fast' });
      w.eval("CS.f['ts-goal']='New objective'");
      w.eval("CHANGES.cafeSel({target:{id:'ts-goal-cat',value:'opus'}})");
      w.document.querySelector('[data-act="cafeTsGoal"][data-v="save"]').click();
      await w.__settled();
      await vi.waitFor(() =>
        expect(action).toHaveBeenLastCalledWith('threadGoalSave', {
          threadId: id,
          value: JSON.stringify({ objective: 'New objective', status: 'active', tokenBudget: null, catId: 'opus' }),
        }),
      );
      expect(action).toHaveBeenLastCalledWith('threadGoalSave', {
        threadId: id,
        value: JSON.stringify({ objective: 'New objective', status: 'active', tokenBudget: null, catId: 'opus' }),
      });
      expect(post).not.toHaveBeenCalled();
      w.eval("CS.f['ts-goal']='Owner objective'");
      await w.eval("A.cafeTsGoal({v:'save',catId:'opus'})");
      expect(post).toHaveBeenLastCalledWith(
        '/api/threads/' + id + '/goal/reconcile',
        {},
        { mode: 'retry', catId: 'opus' },
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
});

describe('r141 placement owners', () => {
  it('registers audit and marketplace views and actions using held receipts, with no request from a VM read', async () => {
    const { dom, w, port, action, errors } = await boot();
    const raw = {
      ...settingsInput(),
      audit: {
        entries: [
          {
            timestamp: 'now',
            capabilityId: 'skill-real',
            action: 'enable',
            userId: 'owner',
            before: null,
            after: { type: 'skill' },
          },
          {
            timestamp: 'then',
            capabilityId: 'mcp-real',
            action: 'disable',
            userId: 'owner',
            before: { type: 'mcp' },
            after: null,
          },
        ],
      },
      marketSources: {
        sources: [
          {
            id: 'user',
            url: 'https://plugins.test/repo',
            origin: 'user',
            status: 'ready',
            branch: 'stable',
            commit: 'abc',
          },
          {
            id: 'system',
            url: 'https://plugins.test/system',
            origin: 'builtin',
            status: 'error',
            error: 'sync failed',
          },
        ],
      },
    };
    const push = () => {
      port.data = { ...port.data, project: { settings: raw } };
      w.clowderChat.update(port);
    };
    action.mockImplementation(async () => {
      push();
      return true;
    });
    try {
      push();
      w.eval("S.project='default';A.capAudit({capabilityType:'skill'})");
      await w.__settled();
      expect(w.eval('VM.chatModal().data.items.map(x=>[x.action,x.capabilityId])')).toEqual([['enable', 'skill-real']]);
      expect(action).toHaveBeenCalledWith('settingsCapAuditRead', { projectPath: '' }, undefined);
      expect(
        (w.eval("go('skills')"), declaredMenu(w, 'capAudit').some((x: { act: string }) => x.act === 'capAudit')),
      ).toBe(true);
      expect(
        (w.eval("go('mcp')"), declaredMenu(w, 'capAudit').some((x: { act: string }) => x.act === 'capAudit')),
      ).toBe(true);
      w.eval("CS.modal=null;go('marketSources')");
      await w.__settled();
      expect(w.document.querySelector('[data-act="marketSourcesRefresh"]')).not.toBeNull();
      expect(w.eval('VM.marketSources().sources.map(x=>x.canRemove)')).toEqual([true, false]);
      w.document.getElementById('market-branch').value = 'dev';
      await w.eval("A.marketSourceAdd({v:' https://plugins.test/new '})");
      expect(action).toHaveBeenLastCalledWith(
        'settingsMarketWrite',
        { op: 'add', value: '{"url":"https://plugins.test/new","branch":"dev"}' },
        undefined,
      );
      await w.eval('A.marketSourcesRefresh()');
      await w.eval("ENT.marketSource.remove(ENT.marketSource.get('user'))");
      expect(action).toHaveBeenLastCalledWith('settingsMarketWrite', { op: 'delete', id: 'user' });
      action.mockClear();
      port.models.mockClear();
      w.eval("CS.modal={kind:'capAudit',capabilityType:'mcp'}");
      for (let i = 0; i < 20; i++) w.eval('VM.marketSources();MODALS.capAudit(CS.modal)');
      expect(action).not.toHaveBeenCalled();
      expect(port.models).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('opens the page-action dialog and retains the actual page and preview identities through all actions', async () => {
    const { dom, w, port, action, errors } = await boot();
    const raw = {
      ...settingsInput(),
      pageAction: {
        kind: 'available',
        requestMessageId: 'request-owner',
        requestText: 'Inspect page',
        pageUrl: 'https://page.test/',
        pageSelection: true,
        state: 'ready',
        preview: null as object | null,
      },
      pageActionPages: [{ pageId: 'page-owner', title: 'Page', url: 'https://page.test/' }],
    };
    const push = () => {
      port.data = { ...port.data, project: { settings: raw } };
      w.clowderChat.update(port);
    };
    action.mockImplementation(async (name, args) => {
      if (name === 'settingsPageAction' && args.op === 'select')
        Object.assign(raw.pageAction, {
          pageSelection: false,
          state: 'awaiting_consent',
          preview: {
            previewId: 'preview-owner',
            field: 'body',
            operation: 'read',
            permissionScope: 'visible_page',
            expiresAtMs: 123456,
          },
        });
      push();
      return true;
    });
    try {
      push();
      w.eval('A.pageActionOpen()');
      await w.__settled();
      expect(w.eval('VM.pageAction().canSelect')).toBe(true);
      expect(w.document.querySelector('[data-view="dlg.pageAction"]')).not.toBeNull();
      await w.eval("CHANGES.pageActionPick({target:{value:'page-owner'}})");
      expect(w.eval('VM.pageAction().previewId')).toBe('preview-owner');
      expect(w.eval('VM.pageAction().canConfirm')).toBe(true);
      await w.eval("A.pageAction({op:'inspect'})");
      await w.eval("A.pageAction({op:'confirm',previewId:'preview-owner'})");
      await w.eval("A.pageAction({op:'revoke',previewId:'preview-owner'})");
      expect(action.mock.calls.filter(([name]) => name === 'settingsPageAction').map(([, args]) => args)).toEqual([
        { op: 'select', previewId: undefined, pageId: 'page-owner' },
        { op: 'inspect', previewId: undefined, pageId: 'page-owner' },
        { op: 'confirm', previewId: 'preview-owner', pageId: 'page-owner' },
        { op: 'revoke', previewId: 'preview-owner', pageId: 'page-owner' },
      ]);
      action.mockClear();
      port.models.mockClear();
      for (let i = 0; i < 20; i++) w.eval('VM.pageAction()');
      expect(action).not.toHaveBeenCalled();
      expect(port.models).not.toHaveBeenCalled();
      raw.pageActionError = 'preview_expired';
      expect(await w.eval("A.pageAction({op:'confirm',previewId:'preview-owner'})")).toBe(false);
      expect(w.eval('VM.pageAction().load')).toBe('error');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('keeps rejected permission drafts and strips backend-only group metadata', async () => {
    const { dom, w, port, action, errors } = await boot();
    const fields = [
      {
        key: 'login',
        kind: 'operation',
        label: 'Login',
        actions: [
          { id: 'begin', label: 'Begin', render: 'button', next: 'poll' },
          { id: 'poll', label: 'Poll', render: 'polling' },
        ],
      },
    ];
    const raw = {
      ...settingsInput(),
      plugins: { plugins: [] },
      pluginPermissions: {
        plugin: {
          revision: 7,
          whitelistEnabled: true,
          commandAdminOnly: false,
          adminOpenIds: [],
          allowedGroups: [{ externalChatId: 'group', label: 'Group', addedAt: 88 }],
        },
      },
      pluginDetails: { plugin: { configFields: fields } },
    };
    let reject = true;
    action.mockImplementation(async (name) => {
      if (name === 'settingsPluginPermissionsSave' && reject) throw new Error('permission_revision_conflict');
      port.data = { ...port.data, project: { settings: raw } };
      w.clowderChat.update(port);
      return true;
    });
    try {
      port.data = { ...port.data, project: { settings: raw } };
      w.clowderChat.update(port);
      w.eval("A.pluginDisconnect({pluginId:'plugin',key:'binding-owner',threadId:'thread-owner',createdAt:'77'})");
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenLastCalledWith('settingsPluginDisconnect', {
        id: 'plugin',
        key: 'binding-owner',
        threadId: 'thread-owner',
        createdAt: '77',
      });
      w.eval(
        "pluginPermissionsVM('plugin','Permissions');pcfSet('plugin|permissions','allowedGroups',JSON.stringify([{externalChatId:'group',label:'Changed',addedAt:88}]))",
      );
      await w.eval("FORMS.pluginPermissions({dataset:{p:'plugin|permissions'}})");
      expect(w.eval("pluginPermissionsVM('plugin','Permissions').error")).toBe('permission_revision_conflict');
      expect(w.eval("pcfState('plugin|permissions').draft.allowedGroups")).toContain('Changed');
      reject = false;
      await w.eval("FORMS.pluginPermissions({dataset:{p:'plugin|permissions'}})");
      expect(
        JSON.parse(action.mock.calls.find(([name]) => name === 'settingsPluginPermissionsSave')![1].value),
      ).toEqual({ expectedRevision: 7, allowedGroups: [{ externalChatId: 'group', label: 'Changed' }] });
      expect(w.eval("pcfState('plugin|permissions').draft")).toEqual({});
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
});

it('renders hooks and connectivity in the member runtime section and dispatches the current draft without saving it', async () => {
  const { dom, w, data, action, port, errors } = await boot();
  Object.assign(data.cats[0], { accountRef: 'account-owner', configurationSource: 'managed_account' });
  const raw = {
    ...settingsInput(),
    hooks: { status: 'stale', targets: [{ name: 'Codex', reason: 'older hooks' }] },
    connections: {} as Record<string, object>,
  };
  const metadata = {
    accounts: [{ id: 'account-owner', clientId: 'openai', displayName: 'Owner', authType: 'api_key', models: [] }],
    templates: [],
    blank: initialState(),
    codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    strategies: [],
    runtimes: [],
    libraries: [],
    clients: CLIENT_OPTIONS.map((c) => ({
      id: c.value,
      label: c.label,
      carriers: carrierOptionsForClient(c.value).map((v) => [v.value, v.label]),
      accounts: ['account-owner'],
    })),
  };
  action.mockImplementation(async (name, args) => {
    if (name === 'membersRead') return structuredClone(metadata);
    if (name === 'memberCanonRead') return { bound: false, versions: [] };
    if (name === 'settingsMemberConnection')
      raw.connections[args.key] = { ok: true, skipped: true, message: 'Probe not supported' };
    if (name === 'settingsHooksSync') raw.hooks.status = 'configured';
    port.data = { ...port.data, project: { settings: raw } };
    return true;
  });
  try {
    port.data = { ...fixtureInput(data), project: { settings: raw } };
    w.clowderChat.update(port);
    w.eval("go('member-codex')");
    await w.__settled();
    expect(w.document.querySelector('[data-act="memberHooksSync"]')).not.toBeNull();
    expect(w.document.querySelector('[data-act="memberConnection"]')).not.toBeNull();
    await w.eval('A.memberConnection()');
    const request = action.mock.calls.find(([name]) => name === 'settingsMemberConnection')![1];
    expect(JSON.parse(request.value)).toMatchObject({ profileId: 'account-owner', clientId: 'openai' });
    expect(w.eval('VM.member().form.runtime.connection.status')).toBe('skipped');
    w.eval('A.memberHooksSync()');
    await w.eval('dialogSubmit()');
    expect(w.eval('VM.member().form.runtime.hooks.status')).toBe('configured');
    expect(action.mock.calls.filter(([name]) => name === 'memberSave')).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

describe('r144 settings menu and dialog registrations', () => {
  const service = (id: string, enabled: boolean) => ({
    id,
    name: id,
    description: id,
    category: 'voice',
    features: ['voice-output'],
    status: 'healthy',
    installed: true,
    enabled,
    installable: true,
    endpoint: 'http://127.0.0.1:9333',
    port: 9333,
    selectedModel: 'vendor/current',
    prerequisites: { models: [{ name: 'vendor/recommended' }] },
  });
  const voice = () => ({
    ...ownerData().voice,
    settings: { customTerms: [], customPrompt: null, language: 'zh' },
    services: { load: '', items: [service('mlx-tts', true), service('whisper-stt', false)] },
    installPreviews: {} as Record<string, unknown>,
  });
  const preview = {
    profile: {
      os: 'linux',
      arch: 'x64',
      gpu: 'cuda',
      gpuDetail: 'Owner GPU',
      ramGb: 31,
      diskFreeGb: 230,
      pythonVersion: '3.12.5',
      pythonArch: 'native',
    },
    recommendation: {
      models: [{ name: 'vendor/recommended', description: 'Owner recommendation' }],
      customModelHint: { requirement: 'Owner model format' },
    },
    suggestedPort: 9444,
  };

  it('registers profilesPage and opens the existing real member-status owner from its original panel argument', async () => {
    const { dom, w, port, errors } = await boot();
    try {
      w.eval("go('profiles')");
      await w.__settled();
      const profileMenu = declaredMenu(w, 'open', '[data-view="page.profiles"] ');
      expect(profileMenu).toMatchObject([
        { label: w.eval("tc('memberForm.viewInStatus')"), act: 'open', data: { node: 'team', anchor: 'panel' } },
      ]);
      w.document.querySelector('[data-pop="menu"] [data-act="open"]').click();
      await w.__settled();
      expect(w.eval("rtCur('panel')")).toBe('team');
      expect(port.models).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('registers svc from held service ids and awaits uninstall under the r145 entity confirmation', async () => {
    const { dom, w, port, action, get, post, errors } = await boot(),
      raw = voice();
    let reject = true,
      finish!: () => void;
    action.mockImplementation(async (name) => {
      if (name === 'voiceInstallRead') return preview;
      if (name === 'voiceService') {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (reject) throw new Error('Uninstall owner rejected');
        raw.services.items[1].installed = false;
      }
      port.data = { ...port.data, project: { voice: raw } };
      return true;
    });
    try {
      port.data = { ...port.data, project: { voice: raw } };
      w.clowderChat.update(port);
      w.eval("go('voice')");
      await w.__settled();
      get.mockClear();
      post.mockClear();
      expect(declaredMenu(w, 'voiceInstallOpen', '[data-view="page.voice"] ')).toMatchObject([
        {
          label: w.eval("tc('voice.serviceMenu.editPortOrModel')"),
          act: 'voiceInstallOpen',
          data: { kind: 'install', id: 1, modify: '1' },
        },
        {
          label: w.eval("tc('common.uninstall')"),
          act: 'setStatus',
          data: { entity: 'svc', id: 1, v: 'none' },
          danger: true,
        },
      ]);
      w.document.querySelector('[data-pop="menu"] [data-kind="install"]').click();
      await w.__settled();
      expect(action).toHaveBeenCalledWith('voiceInstallRead', { id: 'whisper-stt' });
      expect(w.document.getElementById('svc-port').value).toBe('9333');
      w.eval("A.close({path:'s.dialog'})");
      declaredMenu(w, 'setStatus', '[data-view="page.voice"] ');
      w.document.querySelector('[data-pop="menu"] [data-act="setStatus"]').click();
      expect(w.document.querySelector('.dialog')?.textContent).toContain('whisper-stt');
      expect(action.mock.calls.filter(([name]) => name === 'voiceService')).toHaveLength(0);
      const first = w.eval('dialogSubmit()');
      expect(w.eval('S.dialog')).toBeNull(); // closed while its owner works; the trigger shows progress
      expect(action).toHaveBeenLastCalledWith('voiceService', { id: 'whisper-stt', op: 'uninstall' });
      finish();
      await first;
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Uninstall owner rejected');
      expect(w.eval('VM.voice().svc[1].installed')).toBe(true);
      reject = false;
      const second = w.eval('dialogSubmit()');
      expect(w.eval('S.dialog')).toBeNull(); // closed while its owner works; the trigger shows progress
      finish();
      await second;
      expect(w.document.querySelector('.dialog')).toBeNull();
      expect(w.eval('VM.voice().svc[1].installed')).toBe(false);
      expect(w.document.querySelector('[data-view="page.voice"] [data-menu][data-k="mlx-tts"]')).toBeNull();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(port.models).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('registers voicePage and resets actual voice preferences with native undo and no service lifecycle write', async () => {
    const { dom, w, port, action, post, errors } = await boot(),
      raw = voice();
    const before = { customTerms: [{ from: 'old', to: 'new' }], customPrompt: 'Owner prompt', language: 'en' };
    action.mockImplementation(async (name, args) => {
      raw.settings =
        name === 'voiceSettingsReset'
          ? { customTerms: [], customPrompt: null, language: 'zh' }
          : JSON.parse(args.value);
      port.data = { ...port.data, project: { voice: raw } };
      return true;
    });
    try {
      port.data = { ...port.data, project: { voice: { ...raw, settings: before } } };
      w.clowderChat.update(port);
      w.eval("go('voice')");
      await w.__settled();
      expect(declaredMenu(w, 'reset', '[data-view="page.voice"] ')).toMatchObject([
        { label: w.eval("tc('voice.page.label')"), act: 'reset', data: { scope: 'voice' }, danger: true },
      ]);
      await w.eval("A.reset({scope:'voice'})");
      expect(action).toHaveBeenLastCalledWith('voiceSettingsReset', {}, undefined);
      expect(w.eval('VM.voice().terms')).toEqual([]);
      expect(w.eval('VM.voice().sttLang')).toContain('zh');
      await w.eval('UNDO.cur.undo()');
      expect(JSON.parse(action.mock.calls.at(-1)![1].value)).toEqual(before);
      expect(w.eval('VM.voice().terms[0]')).toMatchObject({ a: 'old', b: 'new' });
      expect(w.eval('VM.voice().prompt')).toBe('Owner prompt');
      expect(post).not.toHaveBeenCalled();
      expect(port.models).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('registers install using the host preview and preserves a rejected modify form, with only explicit confirmation writing', async () => {
    const { dom, w, port, action, get, post, errors } = await boot(),
      raw = voice();
    let reject = true;
    action.mockImplementation(async (name) => {
      if (name === 'voiceInstallRead') return preview;
      if (name === 'voiceService' && reject) throw new Error('Service configuration rejected');
      port.data = { ...port.data, project: { voice: raw } };
      return true;
    });
    try {
      port.data = { ...port.data, project: { voice: raw } };
      w.clowderChat.update(port);
      get.mockClear();
      post.mockClear();
      w.eval("A.voiceInstallOpen({id:'1',modify:'1'})");
      await w.__settled();
      expect(action).toHaveBeenCalledWith('voiceInstallRead', { id: 'whisper-stt' });
      expect(action.mock.calls.filter(([name]) => name === 'voiceService')).toHaveLength(0);
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Owner GPU');
      expect(w.eval('S.dialog.args.host.memory')).toBe(31);
      expect(w.document.getElementById('svc-port').value).toBe('9333');
      w.eval("A.set({path:'dlgf.svc-model.opts.cur',v:'custom'})");
      w.document.getElementById('svc-custom').value = 'vendor/custom';
      w.document.getElementById('svc-port').value = '9555';
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenLastCalledWith('voiceService', {
        id: 'whisper-stt',
        op: 'reconfigure',
        port: '9555',
        model: 'vendor/custom',
      });
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Service configuration rejected');
      expect(w.document.getElementById('svc-custom').value).toBe('vendor/custom');
      expect(w.document.getElementById('svc-port').value).toBe('9555');
      reject = false;
      await w.eval('dialogSubmit()');
      expect(w.document.querySelector('.dialog')).toBeNull();
      w.eval('A.svcInstall({i:1})');
      await w.__settled();
      expect(w.document.getElementById('svc-port').getAttribute('placeholder')).toBe('9444');
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenLastCalledWith('voiceService', {
        id: 'whisper-stt',
        op: 'install',
        port: '',
        model: 'vendor/recommended',
      });
      raw.services.items[1].installed = false;
      raw.services.items[1].prerequisites.models = [];
      port.data = { ...port.data, project: { voice: raw } };
      w.clowderChat.update(port);
      const previewReads = action.mock.calls.filter(([name]) => name === 'voiceInstallRead').length;
      await w.eval('A.svcInstall({i:1})');
      expect(action).toHaveBeenLastCalledWith('svcInstall', { i: 1 }, undefined);
      expect(action.mock.calls.filter(([name]) => name === 'voiceInstallRead')).toHaveLength(previewReads);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(port.models).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('keeps the r145 rules view without the removed demo add-rule trigger', async () => {
    const { dom, w, get, post, action, errors } = await boot(),
      original = get.getMockImplementation()!;
    const file = { path: 'rules/owner.md', content: 'Actual rule', exists: true, consumption: { label: 'Owner rule' } };
    get.mockImplementation(async (name, params) =>
      name === '/api/rules'
        ? { sharedRules: [file], providerGuides: [], l0Prompts: { template: file } }
        : name === '/api/prompt-injection/manifest'
          ? { segments: [] }
          : original(name, params),
    );
    try {
      w.eval("go('rules')");
      await w.__settled();
      w.eval("A.set({path:'s.rulesView',v:'agent'})");
      await w.__settled();
      expect(w.eval('VM.rules().view')).toBe('agent');
      expect(w.eval('typeof DIALOGS.ruleAdd')).toBe('undefined');
      expect(w.document.querySelector('[data-act="dialog"][data-kind="ruleAdd"]')).toBeNull();
      expect(post).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
});
