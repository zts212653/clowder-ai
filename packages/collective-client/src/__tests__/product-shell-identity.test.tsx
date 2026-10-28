// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductShell } from '../ProductShell.js';

const collective = {
  collectiveId: 'col_12345678',
  name: '猫猫研究所',
  createdByHumanId: 'human_12345678',
  createdAt: '2026-08-29T00:00:00.000Z',
  role: 'steward' as const,
};

describe('Collective current-Human identity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState({}, '', '/');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows the actual Human, bound GitHub account, and their declared cats below the collective title', async () => {
    const openSelf = vi.fn();
    const switchAccount = vi.fn();
    await act(async () =>
      root.render(
        <ProductShell
          embedded={false}
          collective={collective}
          connection="online"
          canSteward
          canPair={false}
          identity={{
            human: {
              humanId: 'human_12345678',
              displayName: 'You',
              avatarUrl: 'https://avatars.githubusercontent.com/u/1',
            },
            auth: { provider: 'github', handle: 'zts212653' },
            cats: [
              { connectionId: 'con_home1', catId: 'codex-sol', displayName: '小太阳·砚砚' },
              { connectionId: 'con_home1', catId: 'sonnet', displayName: '宪宪' },
            ],
          }}
          onOpenSelf={openSelf}
          onSwitchAccount={switchAccount}
          onInvite={() => undefined}
          onPair={() => undefined}
        >
          <p>频道</p>
        </ProductShell>,
      ),
    );

    const summary = container.querySelector('summary[aria-label="当前身份：You"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('You');
    expect(container.textContent).toContain('你在猫猫研究所里是');
    expect(container.textContent).toContain('用 GitHub 账号 @zts212653 登录');
    expect(container.textContent).toContain('你的猫在这里');
    expect(container.textContent).toContain('小太阳·砚砚');
    expect(container.textContent).toContain('宪宪');

    const details = summary?.closest('details');
    details?.setAttribute('open', '');
    const profile = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '看我的成员资料',
    );
    await act(async () => profile?.click());
    expect(openSelf).toHaveBeenCalledOnce();
    expect(details?.hasAttribute('open')).toBe(false);

    details?.setAttribute('open', '');
    const switcher = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '换账号…',
    );
    await act(async () => switcher?.click());
    expect(switchAccount).toHaveBeenCalledOnce();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('keeps an honest loading state instead of inventing a cat roster', async () => {
    await act(async () =>
      root.render(
        <ProductShell
          embedded
          collective={collective}
          connection="online"
          canSteward={false}
          canPair={false}
          identity={{
            human: { humanId: 'human_12345678', displayName: 'You' },
            auth: { provider: 'github', handle: 'zts212653' },
          }}
          onOpenSelf={() => undefined}
          onSwitchAccount={() => undefined}
          onInvite={() => undefined}
          onPair={() => undefined}
        >
          <p>频道</p>
        </ProductShell>,
      ),
    );

    expect(container.textContent).toContain('正在读取我的猫…');
    expect(container.textContent).not.toContain('你的猫不在这里');
  });

  it('keeps the identity and actions understandable in English and to screen readers', async () => {
    window.history.replaceState({}, '', '/?lang=en');
    await act(async () =>
      root.render(
        <ProductShell
          embedded={false}
          collective={collective}
          connection="online"
          canSteward={false}
          canPair={false}
          identity={{
            human: { humanId: 'human_12345678', displayName: 'You' },
            auth: { provider: 'github', handle: 'zts212653' },
            cats: [],
          }}
          onOpenSelf={() => undefined}
          onSwitchAccount={() => undefined}
          onInvite={() => undefined}
          onPair={() => undefined}
        >
          <p>Channel</p>
        </ProductShell>,
      ),
    );

    expect(container.querySelector('summary[aria-label="Current identity: You"]')).not.toBeNull();
    expect(container.textContent).toContain('You are You in 猫猫研究所');
    expect(container.textContent).toContain('Signed in with GitHub as @zts212653');
    expect(container.textContent).toContain('View my member profile');
    expect(container.textContent).toContain('Switch account…');
  });
});
