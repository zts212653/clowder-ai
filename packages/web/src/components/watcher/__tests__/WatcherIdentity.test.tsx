import { getConnectorDefinition } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, expect, it, vi } from 'vitest';
import { ConnectorIcon } from '../../icons/ConnectorIcon';
import { WatcherChip } from '../WatcherThreadControls';

const mocks = vi.hoisted(() => ({ panel: true }));
vi.mock('@/hooks/useWatcher', () => ({
  useWatcher: () => ({
    state: {
      rolloutEnabled: true,
      enabled: true,
      reviewing: true,
      memberName: '旧的单只名字',
      capability: { supported: false },
      config: {
        memberCatId: 'single',
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
