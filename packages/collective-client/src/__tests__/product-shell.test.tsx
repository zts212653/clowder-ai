import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProductShell } from '../ProductShell.js';

const collective = {
  collectiveId: 'col_12345678',
  name: 'Clowder AI Collective',
  createdByHumanId: 'human_12345678',
  createdAt: '2026-08-29T00:00:00.000Z',
  role: 'steward' as const,
};

describe('Collective product shell', () => {
  it('does not invent a channel before Service data is available', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded={false}
        collective={collective}
        connection="online"
        canSteward={false}
        canPair={false}
        onInvite={() => undefined}
        onPair={() => undefined}
      >
        <p>正在读取共同家园</p>
      </ProductShell>,
    );

    expect(html).not.toContain('data-experience-gate');
    expect(html).not.toContain('general');
  });

  it('uses Service-owned world navigation and the accepted destination/scene grammar', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded={false}
        collective={collective}
        collectives={[collective]}
        connection="online"
        canSteward
        canPair
        onInvite={() => undefined}
        onPair={() => undefined}
      >
        <p>真实 Channel</p>
      </ProductShell>,
    );

    expect(html).toContain('data-spatial-role="global-rail"');
    expect(html).toContain('data-spatial-role="destination-pane"');
    expect(html).toContain('data-spatial-role="primary-scene"');
    expect(html).toContain('aria-label="Clowder AI Collective"');
    expect(html).not.toContain('我的 Café');
    expect(html).not.toContain('Needs Me');
    expect(html).not.toContain('Canonical order');
    expect(html).not.toContain('Service truth');
  });

  it('does not duplicate Clowder AI world chrome in the embedded launch surface', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded
        collective={collective}
        connection="offline"
        canSteward
        canPair
        onInvite={() => undefined}
        onPair={() => undefined}
      >
        <p>真实 Channel</p>
      </ProductShell>,
    );

    expect(html).not.toContain('data-spatial-role="global-rail"');
    expect(html).toContain('连接此 Café');
    expect(html).toContain('暂时离线');
  });

  it('lets an embedded member pair their own Café without exposing steward governance', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded
        collective={{ ...collective, role: 'member' }}
        connection="online"
        canSteward={false}
        canPair
        canLeave
        onInvite={() => undefined}
        onPair={() => undefined}
        onLeave={() => undefined}
      >
        <p>真实 Channel</p>
      </ProductShell>,
    );

    expect(html).toContain('连接此 Café');
    expect(html).toContain('退出共同家园');
    expect(html).not.toContain('邀请成员');
    expect(html).toContain('共同家园在线 · 这台 Café 还没连接');
    expect(html).not.toContain('共同现场已连接');
  });

  it('separates Service availability from an exact paired Café and its current cats', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded
        collective={collective}
        connection="online"
        cafeConnection={{ catCount: 2 }}
        canSteward={false}
        canPair={false}
        onInvite={() => undefined}
        onPair={() => undefined}
      >
        <p>真实 Channel</p>
      </ProductShell>,
    );

    expect(html).toContain('这台 Café 已连接 · 2 位猫猫在场');
    expect(html).not.toContain('连接此 Café');
  });
});
