// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ownerConsole } from './owner-console';
import { settingsInput } from './owner-fixtures';

it('retains the placement snapshot, diffs marketplace rows by id, and projects VMs without reading models', () => {
  const context = ownerConsole();
  Object.assign(context, {
    api: { ...context.api, on: vi.fn() },
    A: { refresh() {} },
    PAGES: {},
    DIALOGS: {},
    CHANGES: {},
    ENT: {},
    RESETS: {},
    MENU_FNS: {},
    MODALS: {},
    onRender() {},
    tc: (key: string) => key,
  });
  context.VM.chatModal = () => null;
  context.render = vi.fn();
  context.chatPort = {
    models: vi.fn(() => {
      throw new Error('models must not be called');
    }),
  };
  new Script(readFileSync(path.join(process.cwd(), 'public/pdl-app/placement.js'), 'utf8')).runInContext(context);
  new Script('bindPlacement()').runInContext(context);
  const before = {
    ...settingsInput(),
    marketSources: {
      sources: [
        { id: 'a', url: 'https://plugins.test/a', origin: 'user', status: 'ready' },
        { id: 'b', url: 'https://plugins.test/b', origin: 'user', status: 'ready' },
      ],
    },
    pageAction: { kind: 'available', requestMessageId: 'owner', state: 'ready' },
  };
  context.CS.voice.pageAction = { pageId: '' };
  context.pushProjectData({ settings: before });
  const held = context.chatDataSnapshot.project.settings,
    kept = held.marketSources.sources[1];
  context.render.mockClear();
  expect(context.pushProjectData({ settings: before }).settings).toEqual({
    added: [],
    changed: [],
    removed: [],
    fields: [],
    orderChanged: false,
  });
  expect(context.chatDataSnapshot.project.settings).toBe(held);
  for (let i = 0; i < 100; i++) {
    context.VM.marketSources();
    context.VM.pageAction();
  }
  expect(context.render).not.toHaveBeenCalled();
  expect(context.chatPort.models).not.toHaveBeenCalled();
  let after = { ...before };
  after = {
    ...after,
    marketSources: {
      ...after.marketSources,
      sources: after.marketSources.sources.map((entry, index) =>
        index === 0 ? { ...after.marketSources.sources[0], status: 'error' } : entry,
      ),
    },
  };
  expect(context.pushProjectData({ settings: after }).settings).toEqual({
    added: [],
    changed: ['a'],
    removed: [],
    fields: [],
    orderChanged: false,
  });
  expect(context.chatDataSnapshot.project.settings.marketSources.sources[1]).toBe(kept);
  const withConnections = { ...after, connections: { accountA: { ok: true }, accountB: { ok: true } } };
  context.pushProjectData({ settings: withConnections });
  const other = context.chatDataSnapshot.project.settings.connections.accountB;
  const rejected = { ...withConnections, connections: { ...withConnections.connections, accountA: { ok: false } } };
  expect(context.pushProjectData({ settings: rejected }).settings.changed).toEqual(['accountA']);
  expect(context.chatDataSnapshot.project.settings.connections.accountB).toBe(other);
});
