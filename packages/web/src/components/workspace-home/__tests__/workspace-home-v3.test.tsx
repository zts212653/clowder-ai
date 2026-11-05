import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { data, homeContentFixture, imageArtifact, props } from './home-content-fixture';
import { hold, seed } from './home-fixtures';

describe('Workspace v3 Home content', () => {
  const scene = homeContentFixture();
  it('shows all 20 executions as 20 rows, including two executions from the same cat/conversation', async () => {
    await scene.render();
    expect(scene.host.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(20);
    expect(scene.host.querySelector('[data-testid="workspace-running-here"]')).not.toBeNull();
    expect(scene.host.querySelectorAll('[data-testid="workspace-running-activity"]')).toHaveLength(0);
  });
  it('says the current conversation’s cat is waiting when only a held ball remains', async () => {
    seed([], [hold('codex61-sol', 'thread-here', '完整的当前对话名称')]);
    await scene.render();
    const summary = scene.host.querySelector('[data-testid="workspace-home-status-summary"]');
    expect(summary?.textContent).toContain('在等');
    expect(summary?.textContent).toContain('02:11 醒');
    expect(summary?.textContent).not.toContain('当前没有执行');
  });
  it('has three content sections and moves tool search off the Home', async () => {
    await scene.render();
    expect([...scene.host.querySelectorAll('h2')].map((node) => node.textContent)).toEqual([
      '正在发生',
      '状态与会话',
      '作品',
    ]);
    expect(scene.host.querySelector('[data-testid="workspace-launcher-home"]')).toBeNull();
    expect(scene.host.querySelectorAll('[data-testid="workspace-home-status-summary"]')).toHaveLength(1);
    expect(scene.host.querySelector('[data-testid="workspace-home-artifact-card"] img')?.getAttribute('src')).toBe(
      imageArtifact.url,
    );
  });
  it('anchors the conversation sections with icons and shows the conversation title once above them', async () => {
    await scene.render();
    expect(scene.host.querySelector('[data-testid="home-conversation-scope"]')?.textContent).toBe(
      '这条对话完整的当前对话名称',
    );
    const sections = [...scene.host.querySelectorAll('section[aria-labelledby]')];
    expect(
      sections
        .find((section) => section.getAttribute('aria-labelledby') === 'home-status-title')
        ?.querySelector('header svg'),
    ).not.toBeNull();
    const works = sections.find((section) => section.getAttribute('aria-labelledby') === 'home-works-title');
    expect(works?.querySelector('header svg')).not.toBeNull();
    expect(works?.querySelector('header')?.textContent).toContain('2 件');
    expect(works?.querySelector('header')?.textContent).not.toContain('这条对话');
    data.loading = true;
    await scene.render();
    expect(works?.querySelector('header')?.textContent).toContain('2 件');
    expect(scene.host.querySelector('[data-testid="workspace-home-status-summary"] .home-live-sub')).not.toBeNull();
  });

  it('produces the status owner title in the current language while keeping the canonical destination', async () => {
    writeShellLanguage('en');
    props.onSelectDestination.mockClear();
    await scene.render();
    act(() => scene.host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-status-summary"]')?.click());
    expect(props.onSelectDestination).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'host', id: 'status', label: 'Status & sessions' }),
    );
  });
  it('does not invent version numbers or PR status from list position', async () => {
    await scene.render();
    expect(scene.host.textContent).not.toMatch(/第\s*[12]\s*版|已合入/);
  });
  it('keeps the exact return card visible when newer publications push it out of the first three', async () => {
    const older = {
      ...imageArtifact,
      name: '原来的第三张',
      sourceMessageId: 'old-exact-source',
      url: '/uploads/old.png',
    };
    data.artifacts = [
      ...data.artifacts,
      { ...imageArtifact, name: '新来的图片', sourceMessageId: 'new-source', url: '/uploads/new.png' },
      older,
    ];
    const returnArtifactId = artifactObjectId(older);
    await scene.render({ returnArtifactId });
    const returned = [...scene.host.querySelectorAll('[data-home-artifact-id]')].find(
      (node) => node.getAttribute('data-home-artifact-id') === returnArtifactId,
    );
    expect(returned).toBeDefined();
    expect(returned?.getAttribute('aria-current')).toBe('true');
    expect(scene.host.querySelectorAll('[data-home-artifact-id]')).toHaveLength(3);
  });
  it('reports an exact missing return key without selecting the first work', async () => {
    await scene.render({ returnArtifactId: 'missing-exact-key' });
    expect(scene.host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'unavailable',
    );
    expect(scene.host.querySelector('[aria-current="true"]')).toBeNull();
  });
  it('keeps an exact return pending until its fresh catalogue finishes loading', async () => {
    data.loading = true;
    data.artifacts = [];
    await scene.render({ returnArtifactId: artifactObjectId(imageArtifact) });
    expect(scene.host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'pending',
    );
    expect(scene.host.textContent).not.toContain('无法打开这件作品');
    data.loading = false;
    data.artifacts = [imageArtifact];
    await scene.render({ returnArtifactId: artifactObjectId(imageArtifact) });
    expect(scene.host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'ready',
    );
    expect(
      scene.host
        .querySelector('button[data-home-artifact-id][aria-current="true"]')
        ?.getAttribute('data-home-artifact-id'),
    ).toBe(artifactObjectId(imageArtifact));
  });
  it('reports a failed fresh catalogue without treating a retained card as a successful return', async () => {
    data.error = true;
    await scene.render({ returnArtifactId: artifactObjectId(imageArtifact) });
    expect(scene.host.querySelector('[data-home-artifact-return]')?.getAttribute('data-home-artifact-return')).toBe(
      'unavailable',
    );
    expect(scene.host.querySelector('[aria-current="true"]')).toBeNull();
  });
});
