// @vitest-environment jsdom
import { act, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CollectiveWorkspace } from '../CollectiveWorkspace.js';
import { readChannelEntry } from '../channel-navigation.js';
import type { ClientSnapshot, CollectiveEventEnvelope } from '../client-types.js';
import type { SharedArtifact } from '../collective-artifact-client.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { snapshot as base, participant } from './first-entry-fixture.js';

const at = '2026-10-16T12:00:00.000Z';
const source = (channelId: string, eventId: string, body: string): CollectiveEventEnvelope => ({
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  eventId,
  clientEventId: eventId,
  sequence: eventId === 'source-one' ? 1 : 2,
  actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  target: { kind: 'channel', channelId },
  location: { channelId },
  recipient: { kind: 'channel' },
  body,
  acceptedAt: at,
});
const first = source('general', 'source-one', '第一份共同作品的来源。');
const second = source('research', 'source-two', '后续指南的原工作讨论。');
const request = {
  ...source('research', 'revision-request', '请修订后续指南。'),
  target: { kind: 'message', eventId: second.eventId },
  location: { channelId: 'research', rootEventId: second.eventId },
  replyToEventId: second.eventId,
  recipient: {
    kind: 'agent',
    humanId: participant.humanId,
    agentId: participant.catId,
    connectionId: participant.connectionId,
    participationRevision: 1,
  },
} as CollectiveEventEnvelope;
const artifact = (event: CollectiveEventEnvelope, title: string): SharedArtifact => ({
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  artifactId: `artifact:${event.eventId}`,
  contentRef: `content:${event.eventId}`,
  publishedByHumanId: participant.humanId,
  title,
  mediaType: 'text/markdown',
  sourceEventId: event.eventId,
  sourceLocation: event.location ?? { channelId: 'general' },
  revision: 2,
  accessRevision: 1,
  canApply: true,
  availability: 'available',
  createdAt: at,
  updatedAt: at,
  versionCount: 2,
  versions: [
    {
      ownerRevision: 1,
      blobDigest: `sha256:${'a'.repeat(64)}`,
      receiptRef: `initial-receipt:${event.eventId}`,
      recordedAt: at,
    },
    {
      ownerRevision: 2,
      blobDigest: `sha256:${'b'.repeat(64)}`,
      receiptRef: `unique-adoption-receipt:${event.eventId}`,
      recordedAt: at,
      adoptedByHumanId: participant.humanId,
      authorCatId: participant.catId,
      lineage: {
        requestId: 'request',
        requestEventId: request.eventId,
        proposalRef: 'proposal',
        sourceEventId: event.eventId,
        sourceOwnerRevision: 1,
        location: request.location ?? { channelId: 'research' },
      },
    },
  ],
});

it('recognizes a normal all-works deep link and does not confuse it with a channel or private Host destination', () => {
  window.history.replaceState({}, '', '/?view=artifacts');
  try {
    expect(readChannelEntry('reader')).toMatchObject({ destination: 'library' });
  } finally {
    window.history.replaceState({}, '', '/');
  }
});

it('returns from an exact historical version to the same filtered library and opens that version adoption request in its real source Topic', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  window.history.replaceState({}, '', '/?channelId=general');
  const works = [artifact(first, '接入指南'), artifact(second, '后续指南')];
  const snapshot = {
    ...base,
    events: [first, second, request],
    participants: [{ ...participant, channelIds: ['general', 'research'] }],
  } as ClientSnapshot;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const read = vi.fn(async (work: SharedArtifact, revision = 2) => ({
    contentRef: work.contentRef,
    ownerRevision: revision,
    blobDigest: work.versions[revision - 1].blobDigest,
    text: revision === 1 ? '历史原文保持原样。' : '新版真实正文。',
    view: { canWrite: revision === 2, historyReadOnly: revision === 1, review: { revision: 1, annotations: [] } },
  }));
  function Harness() {
    const [selected, setSelected] = useState<{ artifactId: string; ownerRevision?: number }>();
    const api = useMemo(
      () => ({
        read,
        history: async (work: SharedArtifact) => ({
          artifactId: work.artifactId,
          contentRef: work.contentRef,
          sourceEventId: work.sourceEventId,
          snapshotOwnerRevision: 2,
          snapshot: `sha256:${'a'.repeat(64)}`,
          total: 2,
          offset: 0,
          versions: [...work.versions].reverse(),
        }),
      }),
      [],
    );
    const shared = {
      api,
      catalogue: works,
      status: 'ready',
      selected,
      humanId: participant.humanId,
      open: (work: SharedArtifact, ownerRevision?: number) =>
        setSelected({ artifactId: work.artifactId, ownerRevision }),
      close: () => setSelected(undefined),
      refresh: async () => {},
      humanName: () => 'You',
      catName: () => 'Sol',
      sourceMessage: (eventId: string) => snapshot.events.find((event) => event.eventId === eventId),
    };
    return (
      <CollectiveWorkspace
        embedded={false}
        client={{ snapshot, artifacts: shared } as unknown as ReturnType<typeof useCollectiveClient>}
      />
    );
  }
  const click = async (text: string) =>
    act(async () => {
      const button = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text,
      );
      expect(button, text).toBeDefined();
      button?.click();
    });
  try {
    await act(async () => root.render(<Harness />));
    await click('全部作品');
    const search = host.querySelector<HTMLInputElement>('input[aria-label="搜索作品"]');
    expect(search).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, '后续');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const library = host.querySelector<HTMLElement>('section[aria-label="全部作品"]');
    await act(async () => {
      if (library) library.scrollTop = 180;
      library?.dispatchEvent(new Event('scroll'));
    });
    const card = host.querySelector<HTMLButtonElement>('.shared-artifact-library .shared-artifact-card');
    expect(card?.textContent).toContain('后续指南');
    expect(host.querySelectorAll('.shared-artifact-library .shared-artifact-card')).toHaveLength(1);
    await act(async () => card?.click());
    expect(host.querySelector('.context-panel')?.textContent).toContain(second.body);
    await click('版本记录');
    const history = host.querySelector('dialog[aria-label="版本记录"]');
    expect(history?.textContent).toContain('unique-adoption-receipt');
    const historical = Array.from(history?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === '查看第 1 版',
    );
    await act(async () => historical?.click());
    expect(read).toHaveBeenLastCalledWith(works[1], 1);
    expect(host.textContent).toContain('历史版本，只读查看');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="返回全部作品"]')?.click());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="搜索作品"]')?.value).toBe('后续');
    expect(host.querySelectorAll('.shared-artifact-library .shared-artifact-card')).toHaveLength(1);
    expect(new URL(location.href).searchParams.get('view')).toBe('artifacts');
    expect(library?.scrollTop).toBe(180);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.shared-artifact-library .shared-artifact-card')?.click(),
    );
    await click('版本记录');
    const openRequest = host.querySelector<HTMLButtonElement>('button[aria-label="在讨论中查看第 2 版的请求"]');
    expect(openRequest).not.toBeNull();
    await act(async () => openRequest?.click());
    expect(host.querySelector('.context-panel')?.textContent).toContain(request.body);
    expect(new URL(location.href).searchParams.get('channelId')).toBe('research');
    expect(new URL(location.href).searchParams.get('view')).toBeNull();
    expect(works[1].versions).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState({}, '', '/');
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  }
});
