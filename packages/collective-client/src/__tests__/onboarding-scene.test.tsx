import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OnboardingScene } from '../OnboardingScene.js';

const githubReady = { id: 'github' as const, ready: true as const };
const noop = async () => undefined;

describe('Collective onboarding scene', () => {
  it('asks an invited Human to authenticate instead of trusting a display name', () => {
    const html = renderToStaticMarkup(
      <OnboardingScene
        phase="entry"
        mode="invite"
        providers={[githubReady]}
        onBootstrap={noop}
        onAuthenticate={noop}
        onCreateCollective={noop}
      />,
    );

    expect(html).toContain('使用 GitHub 验证并加入');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('你的名字');
  });

  it('requires Human binding after the bootstrap Collective exists', () => {
    const html = renderToStaticMarkup(
      <OnboardingScene
        phase="bind-identity"
        mode="missing"
        providers={[githubReady]}
        onBootstrap={noop}
        onAuthenticate={noop}
        onCreateCollective={noop}
      />,
    );

    expect(html).toContain('绑定你的 Human 身份');
    expect(html).toContain('继续使用 GitHub 验证');
    expect(html).toContain('已经建立首个 Collective');
    expect(html).not.toContain('Collective 名称');
  });

  it('fails honestly when the deployment has no Human auth provider', () => {
    const html = renderToStaticMarkup(
      <OnboardingScene
        phase="entry"
        mode="missing"
        providers={[{ id: 'github', ready: false, reason: 'not_configured' }]}
        onBootstrap={noop}
        onAuthenticate={noop}
        onCreateCollective={noop}
      />,
    );

    expect(html).toContain('Human 登录尚未配置');
    expect(html).toContain('disabled');
  });
});
