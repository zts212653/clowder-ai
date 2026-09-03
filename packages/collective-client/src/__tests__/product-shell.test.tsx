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
  it('uses the frozen direct-Web spatial grammar and resident language', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded={false}
        collective={collective}
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
    expect(html).toContain('我的 Café');
    expect(html).toContain('Needs Me');
    expect(html).toContain('频道');
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
    expect(html).toContain('离线期间不会冒充已送达');
  });

  it('lets an embedded member pair their own Café without exposing steward governance', () => {
    const html = renderToStaticMarkup(
      <ProductShell
        embedded
        collective={{ ...collective, role: 'member' }}
        connection="online"
        canSteward={false}
        canPair
        onInvite={() => undefined}
        onPair={() => undefined}
      >
        <p>真实 Channel</p>
      </ProductShell>,
    );

    expect(html).toContain('连接此 Café');
    expect(html).not.toContain('邀请成员');
  });
});
