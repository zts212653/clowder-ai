// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { SharedArtifact } from '../collective-artifact-client.js';
import { MemberAvatar } from '../MemberAvatar.js';
import { MemberPanel } from '../MemberPanel.js';
import { OnboardingScene } from '../OnboardingScene.js';
import { ProductShell } from '../ProductShell.js';
import { SharedArtifactLibrary } from '../SharedArtifactLibrary.js';
import { CollectiveArtifactContext } from '../use-collective-artifacts.js';
import { participant, snapshot } from './first-entry-fixture.js';

const cats = [
  { ...participant, displayLabel: '砚砚' },
  { ...participant, displayLabel: '砚砚', connectionId: 'con_second' },
  {
    ...participant,
    displayLabel: '砚砚',
    connectionId: 'con_other_home',
    endpointId: 'ep_other_home',
    endpointLabel: 'Another Café',
  },
];
const members = {
  humans: [
    { humanId: participant.humanId, displayName: 'You', role: 'steward' as const, joinedAt: '2026-10-18T00:00:00Z' },
  ],
  cafes: cats.map(({ connectionId, endpointId, endpointLabel, humanId }) => ({
    connectionId,
    endpointId,
    endpointLabel,
    humanId,
  })),
};

it('groups only proven same-endpoint sessions and keeps different public Cafés distinct with visible headings and counts', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <MemberPanel
      member="members"
      members={members}
      participants={cats}
      events={[]}
      onSelect={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(host.querySelectorAll('.member-family')).toHaveLength(2);
  expect(host.querySelectorAll('.member-row-agent')).toHaveLength(2);
  expect([...host.querySelectorAll('.member-row-agent strong')].map((node) => node.textContent)).toEqual([
    '砚砚',
    '砚砚',
  ]);
  expect(host.querySelectorAll('.member-family > summary')).toHaveLength(2);
  expect(host.querySelector('.member-family > summary')?.textContent).toContain('2');
});

it('requires an explicit connection choice for a multi-session cat instead of silently selecting the first connection', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onSelect = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberPanel
          member="members"
          members={members}
          participants={cats}
          events={[]}
          onSelect={onSelect}
          onClose={() => undefined}
        />,
      ),
    );
    const choices = host.querySelectorAll<HTMLButtonElement>('.member-connection-choice');
    expect(choices).toHaveLength(2);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => choices[1].click());
    expect(onSelect).toHaveBeenCalledWith({ kind: 'agent', catId: participant.catId, connectionId: 'con_second' });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('keeps the channel works pane a compact list with a real all-works destination rather than a search form', () => {
  const shared = {
    catalogue: [],
    status: 'ready',
    humanName: () => 'You',
    open: vi.fn(),
    refresh: vi.fn(),
    members: snapshot.members,
  };
  const html = renderToStaticMarkup(
    <CollectiveArtifactContext.Provider
      value={shared as unknown as NonNullable<React.ContextType<typeof CollectiveArtifactContext>>}
    >
      <SharedArtifactLibrary channelId="general" presentation="channel" onOpenChannelLibrary={() => undefined} />
    </CollectiveArtifactContext.Provider>,
  );
  expect(html).not.toContain('作品筛选');
  expect(html).not.toContain('正文和版本在同一处');
  expect(html).toContain('在全部作品中查看本频道');
});

const artifact = (
  id: string,
  channelId: string,
  mediaType: SharedArtifact['mediaType'] = 'text/markdown',
): SharedArtifact => ({
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  artifactId: id,
  contentRef: `content:${id}`,
  title: `Guide ${id}`,
  mediaType,
  sourceEventId: `source:${id}`,
  sourceLocation: { channelId },
  publishedByHumanId: participant.humanId,
  revision: 1,
  accessRevision: 1,
  canApply: false,
  availability: 'available',
  createdAt: '2026-10-18T00:00:00Z',
  updatedAt: '2026-10-18T00:00:00Z',
  versionCount: 1,
  versions: [
    {
      ownerRevision: 3,
      blobDigest: `sha256:${'a'.repeat(64)}`,
      receiptRef: `receipt:${id}`,
      recordedAt: '2026-10-18T00:00:00Z',
    },
  ],
});

it('filters the gallery by the requested channel, offers only real media types, and opens the exact work and source', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const general = artifact('first', 'general');
  const research = artifact('second', 'research', 'image/png');
  const open = vi.fn();
  const returnToSource = vi.fn();
  const shared = {
    catalogue: [general, research],
    status: 'ready',
    humanName: () => 'You',
    open,
    returnToSource,
    refresh: vi.fn(),
    members: snapshot.members,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (requestedChannel?: { channelId: string; revision: number }) =>
    root.render(
      <CollectiveArtifactContext.Provider
        value={shared as unknown as NonNullable<React.ContextType<typeof CollectiveArtifactContext>>}
      >
        <SharedArtifactLibrary filterable requestedChannel={requestedChannel} />
      </CollectiveArtifactContext.Provider>,
    );
  try {
    await act(async () => render());
    expect(host.querySelectorAll('.shared-artifact-card-tile')).toHaveLength(2);
    expect([...host.querySelectorAll('.artifact-type-filter option')].map((x) => x.textContent)).toEqual([
      '全部类型 · 2',
      'Markdown · 1',
      '图片 · 1',
    ]);
    await act(async () => render({ channelId: 'research', revision: 1 }));
    expect(host.querySelectorAll('.shared-artifact-card-tile')).toHaveLength(1);
    expect(host.querySelector('.shared-artifact-library-count')?.textContent).toContain('找到 1 件作品');
    expect(host.querySelector('.shared-artifact-caption')?.textContent).toContain('You · 第 3 版');
    await act(async () => host.querySelector<HTMLButtonElement>('.shared-artifact-card-tile')?.click());
    expect(open).toHaveBeenCalledWith(research);
    await act(async () => host.querySelector<HTMLButtonElement>('.shared-artifact-source')?.click());
    expect(returnToSource).toHaveBeenCalledWith('research', 'source:second');
    expect(host.querySelector('.shared-artifact-preview img')).toBeNull();
    expect(host.querySelector('.shared-artifact-preview')?.textContent).toContain('图片');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('keeps the same Human initial visible while a trusted avatar is pending and after an image failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<MemberAvatar kind="human" name="You" avatarUrl="https://avatars.githubusercontent.com/u/1" />),
    );
    expect(host.querySelector('.avatar-fallback')?.textContent).toBe('L');
    await act(async () => host.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.avatar-fallback')?.textContent).toBe('L');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('shows ordinary English sign-in copy while keeping an unconfigured provider disabled', () => {
  window.history.replaceState({}, '', '/?lang=en');
  try {
    const noop = async () => undefined;
    const html = renderToStaticMarkup(
      <ProductShell
        embedded={false}
        connection="online"
        canSteward={false}
        canPair={false}
        onInvite={() => undefined}
        onPair={() => undefined}
      >
        <OnboardingScene
          phase="entry"
          mode="missing"
          providers={[{ id: 'github', ready: false, reason: 'not_configured' }]}
          onBootstrap={noop}
          onAuthenticate={noop}
          onConfigureProvider={noop}
          onCreateCollective={noop}
        />
      </ProductShell>,
    );
    expect(html).toContain('<h1>Collective</h1>');
    expect(html).toContain('Sign in to your collective');
    expect(html).toContain('Sign in with GitHub');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Human 登录');
  } finally {
    window.history.replaceState({}, '', '/');
  }
});

it('uses the actual English singular and plural count in gallery and channel results', () => {
  window.history.replaceState({}, '', '/?lang=en');
  try {
    for (const count of [1, 2]) {
      const shared = {
        catalogue: Array.from({ length: count }, (_, index) => artifact(`count-${index}`, 'general')),
        status: 'ready',
        humanName: () => 'You',
        open: vi.fn(),
        refresh: vi.fn(),
        members: snapshot.members,
      };
      const unit = count === 1 ? 'work' : 'works';
      const gallery = renderToStaticMarkup(
        <CollectiveArtifactContext.Provider
          value={shared as unknown as NonNullable<React.ContextType<typeof CollectiveArtifactContext>>}
        >
          <SharedArtifactLibrary filterable />
        </CollectiveArtifactContext.Provider>,
      );
      const host = document.createElement('div');
      host.innerHTML = gallery;
      expect(host.querySelector('h2 small')?.textContent).toBe(`${count} ${unit} · Newest first`);
      expect(host.querySelector('.shared-artifact-library-count')).toBeNull();
      host.innerHTML = renderToStaticMarkup(
        <CollectiveArtifactContext.Provider
          value={shared as unknown as NonNullable<React.ContextType<typeof CollectiveArtifactContext>>}
        >
          <SharedArtifactLibrary channelId="general" presentation="channel" />
        </CollectiveArtifactContext.Provider>,
      );
      expect(host.querySelector('.channel-artifact-heading')?.textContent).toBe(`${count} ${unit} · #general`);
    }
  } finally {
    window.history.replaceState({}, '', '/');
  }
});
