// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Composer } from '../Composer.js';
import type { SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactReading } from '../SharedArtifactReading.js';
import { SharedArtifactSurface } from '../SharedArtifactSurface.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

it('continues a historical annotation in the same Topic composer, preserves typed words and removes only the reference on revoke', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  localStorage.setItem(
    'collective-draft:reply-reader:general:source',
    JSON.stringify({ body: '我的话仍在', recipient: { kind: 'channel' }, recipientLabel: '' }),
  );
  const artifact = {
    artifactId: 'artifact',
    mediaType: 'text/markdown',
    contentRef: 'content',
    title: '共同指南',
    availability: 'available',
    accessRevision: 1,
    sourceEventId: 'source',
    sourceLocation: { channelId: 'general' },
    versions: [
      { ownerRevision: 1, blobDigest: 'digest' },
      { ownerRevision: 2, blobDigest: 'new-digest' },
    ],
  } as unknown as SharedArtifact;
  const annotation = {
    id: 'annotation',
    body: '原来的批注',
    author: { kind: 'human', actorId: 'alice' },
    state: 'open',
    anchor: { kind: 'text_quote', baseRevision: 'digest', quote: '原文' },
    replies: [],
    collectiveMessage: {
      ownerRevision: 1,
      blobDigest: 'digest',
      eventId: 'comment',
      channelId: 'general',
      rootEventId: 'source',
    },
  };
  const view = {
    contentRef: 'content',
    ownerRevision: 1,
    blobDigest: 'digest',
    text: '原文',
    view: {
      canWrite: false,
      canReply: true,
      historyReadOnly: true,
      review: { reviewId: 'review', revision: 3, annotations: [annotation] },
    },
  } as unknown as SharedMarkdownView;
  let confirm = () => {};
  const sendReply = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
  );
  const normalSend = vi.fn(async () => undefined);
  const discussion = vi.fn();
  const api = { read: async () => view, sendReply };
  let denied = false;
  function Harness() {
    const [selected, setSelected] = useState({ artifactId: artifact.artifactId, ownerRevision: 1 });
    const state = {
      api,
      selected,
      catalogue: [artifact],
      status: denied ? 'access_denied' : 'ready',
      humanId: 'bob',
      open: (_work: SharedArtifact, revision = 1) =>
        setSelected({ artifactId: artifact.artifactId, ownerRevision: revision }),
      close: () => {},
      humanName: (id: string) => id,
      refresh: async () => {},
      refreshDiscussion: async () => {},
    } as unknown as CollectiveArtifactState;
    return (
      <CollectiveArtifactContext.Provider value={state}>
        <SharedArtifactReading>
          <SharedArtifactSurface onReturnToSource={() => {}} onOpenDiscussion={discussion} />
          <Composer
            namespace="reply-reader"
            channelId="general"
            rootEventId="source"
            humans={[{ humanId: 'alice', displayName: 'Alice' }]}
            participants={[]}
            replyEvents={[
              {
                eventId: 'comment',
                actor: { kind: 'human', humanId: 'alice', displayName: 'Alice' },
                body: annotation.body,
              } as never,
            ]}
            placeholder="回复"
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
  const replyButton = () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '在原讨论回复');
  try {
    await act(async () => root.render(<Harness />));
    expect(replyButton()).toBeDefined();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === '解决批注')).toBe(false);
    await act(async () => replyButton()?.click());
    expect(discussion).toHaveBeenCalledOnce();
    expect(host.querySelector('textarea')?.value).toBe('我的话仍在');
    expect(host.querySelector('[aria-label="作品引用"]')?.textContent).toContain('回复第 1 版的批注');
    expect(sendReply).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '我的话仍在',
        reply: expect.objectContaining({ annotationId: 'annotation', messageEventId: 'comment' }),
      }),
    );
    expect(normalSend).not.toHaveBeenCalled();
    const nextDraft = host.querySelector('textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        nextDraft,
        '下一条尚未发送的话',
      );
      nextDraft?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => confirm());
    expect(host.querySelector('textarea')?.value).toBe('下一条尚未发送的话');
    expect(host.querySelector('[aria-label="作品引用"]')?.textContent).toContain('回复第 1 版的批注');

    await act(async () => replyButton()?.click());
    const input = host.querySelector('textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, '撤权前自己写的话');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    denied = true;
    await act(async () => root.render(<Harness />));
    expect(host.querySelector('textarea')?.value).toBe('撤权前自己写的话');
    expect(host.querySelector('[aria-label="作品引用"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
