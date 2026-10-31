// @vitest-environment jsdom
import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';
import type { CollectiveParticipant } from '../client-types.js';
import type { SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactReading } from '../SharedArtifactReading.js';
import { SharedArtifactSurface } from '../SharedArtifactSurface.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('prefills a historical candidate reference in the same composer, preserves typed words and sends only after Human confirmation', async () => {
  localStorage.clear();
  const participant = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    endpointId: 'endpoint',
    endpointLabel: 'Café',
    humanDisplayName: 'Owner',
    humanId: 'human_aaaaaaaa',
    catId: 'sol',
    connectionId: 'con_aaaaaaaa',
    participationRevision: 2,
    displayName: 'Sol',
    availability: 'declared',
    channelIds: ['general'],
  } as CollectiveParticipant;
  const recipient = {
    kind: 'agent' as const,
    humanId: participant.humanId,
    agentId: participant.catId,
    connectionId: participant.connectionId,
    participationRevision: participant.participationRevision,
  };
  const old = {
    requestId: 'old-request',
    latestProposalRef: 'old-proposal',
    ownerRevision: 1,
    target: { humanId: participant.humanId, catId: participant.catId },
  } as CollectiveModificationProjection;
  const artifact = {
    artifactId: 'artifact',
    mediaType: 'text/markdown',
    contentRef: 'content',
    accessRevision: 1,
    availability: 'available',
    title: '共同指南',
    sourceEventId: 'evt_source',
    sourceLocation: { channelId: 'general' },
    versions: [
      { ownerRevision: 1, blobDigest: 'old-digest' },
      { ownerRevision: 2, blobDigest: 'current-digest' },
    ],
    canApply: true,
  } as unknown as SharedArtifact;
  const view = {
    contentRef: 'content',
    ownerRevision: 2,
    blobDigest: 'current-digest',
    text: '现在的正文',
    view: { canWrite: true, historyReadOnly: false, review: { revision: 3, annotations: [] } },
  } as unknown as SharedMarkdownView;
  localStorage.setItem(
    'collective-draft:rework-test:general:evt_source',
    JSON.stringify({
      body: '先保留我的想法',
      recipient: { kind: 'channel' },
      recipientLabel: '',
    }),
  );
  const sendFeedback = vi.fn(async () => undefined);
  const normalSend = vi.fn(async () => undefined);
  const showDiscussion = vi.fn();
  let denied = false;
  const api = {
    read: async () => view,
    previewModification: async () => ({ proposal: { response: '旧候选', edits: [] } }),
    sendFeedback,
  };
  function Harness() {
    const [selected, setSelected] = useState({
      artifactId: artifact.artifactId,
      requestId: old.requestId,
      request: old,
    });
    const state = {
      api,
      catalogue: [artifact],
      selected,
      status: denied ? 'access_denied' : 'ready',
      catName: () => 'Sol',
      reworkRecipient: () => ({ recipient, label: 'Sol' }),
      refresh: async () => {},
      refreshDiscussion: async () => {},
      open: () => setSelected({ artifactId: artifact.artifactId } as typeof selected),
      compare: () => {},
      sourceMessage: () => undefined,
    } as unknown as CollectiveArtifactState;
    return (
      <CollectiveArtifactContext.Provider value={state}>
        <SharedArtifactReading>
          <SharedArtifactSurface onReturnToSource={() => {}} onOpenDiscussion={showDiscussion} />
          <Composer
            channelId="general"
            namespace="rework-test"
            rootEventId="evt_source"
            participants={[participant]}
            placeholder="回复讨论"
            delivery={{ kind: 'idle' }}
            onSend={normalSend}
          />
        </SharedArtifactReading>
      </CollectiveArtifactContext.Provider>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const button = Array.from(host.querySelectorAll('button')).find((item) =>
      /基于第 2 版重做/.test(item.textContent ?? ''),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(showDiscussion).toHaveBeenCalledOnce();
    const input = host.querySelector('textarea');
    expect(document.activeElement).toBe(input);
    expect(input?.value).toBe('先保留我的想法\n基于第 2 版重做这一处。');
    expect(host.textContent).toContain('第 1 版的修改');
    expect(host.textContent).toContain('@Sol');
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(normalSend).not.toHaveBeenCalled();
    expect(localStorage.getItem('collective-draft:rework-test:general:evt_source')).toContain('old-proposal');
    await act(async () => root.render(<Harness key="reopened" />));
    expect(host.querySelector('textarea')?.value).toBe('先保留我的想法\n基于第 2 版重做这一处。');
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(sendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact,
        view,
        recipient,
        rework: { requestId: old.requestId, proposalRef: old.latestProposalRef },
        selections: [],
        body: '先保留我的想法\n基于第 2 版重做这一处。',
      }),
    );
    expect(normalSend).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')?.value).toBe('');
    localStorage.setItem(
      'collective-draft:rework-test:general:evt_source',
      JSON.stringify({
        body: '失权后仍是我的话',
        recipient,
        recipientLabel: 'Sol',
        artifactRework: {
          artifactId: artifact.artifactId,
          ownerRevision: 2,
          blobDigest: view.blobDigest,
          sourceOwnerRevision: 1,
          rework: { requestId: old.requestId, proposalRef: old.latestProposalRef },
        },
      }),
    );
    denied = true;
    await act(async () => root.render(<Harness key="revoked" />));
    expect(host.querySelector('textarea')?.value).toBe('失权后仍是我的话');
    expect(host.querySelector('[aria-label="作品引用"]')).toBeNull();
    expect(localStorage.getItem('collective-draft:rework-test:general:evt_source')).not.toContain('old-proposal');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  }
});
