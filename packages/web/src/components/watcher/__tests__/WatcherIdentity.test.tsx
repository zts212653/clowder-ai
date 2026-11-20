import { getConnectorDefinition, WATCHER_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ConnectorIcon } from '../../icons/ConnectorIcon';
import { WatcherChip, WatcherThreadCard } from '../WatcherThreadControls';

const mocks = vi.hoisted(() => ({ panel: true, routing: false, active: [] as string[], unconfigured: false }));
vi.mock('@/hooks/useWatcher', () => ({
  useWatcher: () => ({
    state: {
      rolloutEnabled: true,
      enabled: true,
      reviewing: true,
      reviewingCatIds: mocks.active,
      memberName: mocks.unconfigured ? '' : '旧的单只名字',
      control: { revision: 0 },
      capability: { supported: false },
      config: mocks.unconfigured
        ? WATCHER_CONFIG_DEFAULTS
        : {
            memberCatId: 'single',
            routing: mocks.routing
              ? {
                  primary: { catId: 'sol' },
                  whenSameFamily: { mode: 'member', member: { catId: 'terra' } },
                  maxConcurrentRuns: 6,
                }
              : undefined,
            panel: mocks.panel
              ? {
                  enabled: true,
                  members: [{ catId: 'terra' }, { catId: 'sol' }, { catId: 'astra' }],
                }
              : undefined,
          },
    },
  }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => ({ id, nickname: id, avatar: `/members/${id}.png` }),
  }),
}));
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterEach(() => {
  mocks.panel = true;
  mocks.routing = false;
  mocks.active = [];
  mocks.unconfigured = false;
});

it('an unconfigured thread card links to choosing a primary instead of rendering an empty byline', () => {
  mocks.unconfigured = true;
  const markup = renderToStaticMarkup(<WatcherThreadCard threadId="t" />);
  expect(markup).toContain('href="/settings?s=concierge#watcher"');
  expect(markup).toContain('选择主守望猫');
  expect(markup).toContain('总开关已关闭');
});

it('an anonymous panel reminder uses the designed cat avatar and SVG eye without naming a candidate', () => {
  const definition = getConnectorDefinition('watcher-panel');
  expect(definition?.icon.type).toBe('svg');
  const markup = renderToStaticMarkup(<ConnectorIcon iconSpec={definition?.icon} fallbackIcon={'\u{1f440}'} />);
  expect(markup).toContain('data-watcher="true"');
  expect(markup).toContain('<svg');
  expect(markup).not.toContain('\u{1f440}');
  for (const member of ['terra', 'sol', 'astra']) expect(markup).not.toContain(`/members/${member}.png`);
});

it('the thread header reports all three watchers even when the legacy single-member capability is unavailable', () => {
  const markup = renderToStaticMarkup(<WatcherChip threadId="t" />);
  expect(markup).toContain('守望猫 · 3 只');
  expect(markup.match(/data-watcher="true"/g)).toHaveLength(3);
  expect(markup).not.toContain('旧的单只名字');
});

it('a routed turn shows the actual alternate while reading and the saved primary while idle', () => {
  mocks.routing = true;
  mocks.active = ['terra'];
  let markup = renderToStaticMarkup(<WatcherChip threadId="t" />);
  expect(markup).toContain('守望猫 · terra');
  expect(markup).not.toContain('/members/sol.png');
  expect(markup.match(/data-watcher="true"/g)).toHaveLength(1);
  mocks.active = [];
  markup = renderToStaticMarkup(<WatcherChip threadId="t" />);
  expect(markup).toContain('守望猫 · sol');
  expect(markup).not.toContain('/members/terra.png');
});
